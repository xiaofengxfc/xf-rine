/**
 * 行情连接的路由与自愈：真起服务端、真起代理，把几种真实故障跑一遍。
 *
 *   direct      不配代理，直连应当连上并稳定
 *   tunnel-all  代理正常转发，WebSocket 也走代理，应当连上（验证代理这条路没被改坏）
 *   kill-ws     代理只掐 ws.*（REST 正常），应当自动换到直连
 *   hang-ws     代理把 ws.* 的 CONNECT 挂住不回应（TUN 黑洞的样子），应当超时后换直连
 *   silent      上游接受连接但一帧不发（假死），应当被看门狗掐掉重连
 *
 * 用法：pnpm -F server check:ws-failover
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const SERVER_PORT = 19081;
const PROXY_PORT = 19082;
const SILENT_PORT = 19083;
const OPEN_TIMEOUT_MS = 4000;
/** 假死阈值调小，不然要干等 90 秒 */
const STALE_MS = 4000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let failures = 0;

function ok(name: string, passed: boolean, detail = ''): void {
  if (passed) { console.log('  ✓ ' + name); return; }
  failures += 1;
  console.error('  ✗ ' + name);
  if (detail) console.error('    现场：' + detail.replace(/\s+/g, ' ').slice(0, 500));
}

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(150);
  }
  return fn();
}

// ---------------- 假代理 ----------------
type ProxyMode = 'tunnel-all' | 'kill-ws' | 'hang-ws';

function startProxy(mode: ProxyMode): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
    const up = http.request(
      { host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
    );
    up.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
    req.pipe(up);
  });
  const hanging: Duplex[] = [];
  server.on('connect', (req, clientSocket, head) => {
    const [host = '', portRaw] = String(req.url).split(':');
    const port = Number(portRaw) || 443;
    const isWs = /^ws\./i.test(host);
    if (isWs && mode === 'kill-ws') { clientSocket.destroy(); return; }
    // 黑洞：socket 留着，一个字节都不回。要接住 error，
    // 否则关代理的时候这几个挂起的 socket 会抛成未处理事件，把测试进程带走
    if (isWs && mode === 'hang-ws') {
      hanging.push(clientSocket);
      clientSocket.on('error', () => {});
      return;
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  server.on('close', () => { for (const s of hanging) { try { s.destroy(); } catch { /* 已断 */ } } });
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve(server)));
}

// ---------------- 只握手不推数据的上游 ----------------
function startSilentUpstream(): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ port: SILENT_PORT, host: '127.0.0.1' });
  wss.on('connection', (sock) => { sock.on('message', () => {}); });
  return new Promise((resolve) => wss.on('listening', () => resolve(wss)));
}

// ---------------- 被测试的服务端 ----------------
interface Harness {
  logs: () => string;
  errs: () => string;
  frames: () => number;
}

async function runServer(
  env: Record<string, string>,
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      EXCHANGE: 'bitget',
      XF_WS_OPEN_TIMEOUT_MS: String(OPEN_TIMEOUT_MS),
      XF_WS_STALE_MS: String(STALE_MS),
      XF_WS_FAST_FAIL_MS: '2000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (b) => { out += String(b); });
  child.stderr?.on('data', (b) => { err += String(b); });

  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  const started = await waitFor(() => out.includes('巡风日内台'), 30_000);
  if (!started) {
    console.error('  ✗ 服务端没起来');
    console.error(err.slice(0, 800));
    failures += 1;
    try { child.kill(); } catch { /* 已退 */ }
    await exited;
    return;
  }

  /**
   * 等 hub 自己先连上再建页面客户端。
   *
   * hub 是在 primeProxy 之后才挂到 wss 上的；连太早的话这条连接没人接，
   * 页面侧的 subscribe 石沉大海 —— 测试里就会看到「连着但一帧没有」的假象。
   */
  await waitFor(() => out.includes('[ws] bitget connected'), 25_000);

  let frames = 0;
  const client = new WebSocket('ws://127.0.0.1:' + SERVER_PORT + '/ws');
  client.on('open', () => client.send(JSON.stringify({ type: 'subscribe', contract: 'BTC_USDT', interval: '1m' })));
  client.on('message', () => { frames += 1; });
  client.on('error', () => {});

  try {
    await body({
      logs: () => out,
      errs: () => err,
      frames: () => frames,
    });
  } finally {
    try { client.close(); } catch { /* 已断 */ }
    try { child.kill(); } catch { /* 已退 */ }
    await exited;
    await sleep(400);
  }
}

// ---------------- 场景 ----------------
console.log('行情连接自愈检查（Bitget · 真网络 + 本地假代理）');

// 这台机器上可能本来就配着系统代理，所以这里只断言「连上了、有数据、没掉线」
await runServer({ XF_WS_ROUTE: '' }, async (h) => {
  await sleep(4000);
  ok('不指定路线：按实测选一条并连上', /bitget connected（(直连|走代理)）/.test(h.logs()), h.logs());
  ok('连上之后能收到行情帧', h.frames() > 0, 'frames=' + h.frames());
  ok('期间没有掉线', !h.errs().includes('bitget closed'), h.errs());
});

// 人工指定直连时必须真的走直连
await runServer({ XF_WS_ROUTE: 'direct' }, async (h) => {
  await sleep(4000);
  ok('XF_WS_ROUTE=direct：真的走直连', h.logs().includes('connected（直连）'), h.logs());
  ok('强制直连也能收到行情帧', h.frames() > 0, 'frames=' + h.frames());
});

for (const mode of ['kill-ws', 'hang-ws'] as ProxyMode[]) {
  const proxy = await startProxy(mode);
  await runServer(
    { HTTP_PROXY: 'http://127.0.0.1:' + PROXY_PORT, HTTPS_PROXY: 'http://127.0.0.1:' + PROXY_PORT, XF_WS_ROUTE: 'proxy' },
    async (h) => {
      // 第一次：走代理；超时/秒断之后应换直连并连上
      const recovered = await waitFor(() => h.logs().includes('connected（直连）'), 25_000);
      ok('[' + mode + '] 走代理连不上时自动换直连', recovered, h.errs() + ' || ' + h.logs());
      ok('[' + mode + '] 日志里有换路记录', /换\s*(代理|直连)\s*再试|换直连/.test(h.errs()), h.errs());
      const before = h.frames();
      await sleep(3000);
      ok('[' + mode + '] 换过去之后能拿到行情', h.frames() > before, 'frames ' + before + '→' + h.frames());
    },
  );
  await new Promise<void>((r) => proxy.close(() => r()));
}

{
  const proxy = await startProxy('tunnel-all');
  await runServer(
    { HTTP_PROXY: 'http://127.0.0.1:' + PROXY_PORT, HTTPS_PROXY: 'http://127.0.0.1:' + PROXY_PORT, XF_WS_ROUTE: 'proxy' },
    async (h) => {
      await waitFor(() => h.logs().includes('[ws] bitget connected'), 20_000);
      await sleep(3000);
      ok('[tunnel-all] 代理能通时就走代理', h.logs().includes('connected（走代理）'), h.logs());
      ok('[tunnel-all] 走代理期间不掉线', !h.errs().includes('bitget closed'), h.errs());
      ok('[tunnel-all] 走代理能收到行情帧', h.frames() > 0, 'frames=' + h.frames());
    },
  );
  await new Promise<void>((r) => proxy.close(() => r()));
}

{
  const silent = await startSilentUpstream();
  await runServer(
    { XF_WS_URL: 'ws://127.0.0.1:' + SILENT_PORT, XF_WS_ROUTE: '' },
    async (h) => {
      const connected = await waitFor(() => h.logs().includes('[ws] bitget connected'), 15_000);
      ok('[silent] 上游接受连接', connected, h.logs());
      const stale = await waitFor(() => h.errs().includes('没有任何数据'), 20_000);
      ok('[silent] 一帧不来时被看门狗掐掉', stale, h.errs());
      const reconnected = await waitFor(
        () => (h.logs().match(/bitget connected/g) ?? []).length >= 2,
        20_000,
      );
      ok('[silent] 掐掉之后自己重连', reconnected, h.logs());
    },
  );
  await new Promise<void>((r) => silent.close(() => r()));
}

/**
 * 切交易所时旧 hub 必须真的停下来。
 *
 * undici 的 WebSocket 关连接一定会触发 close 事件，而那个处理器会安排重连 ——
 * 不认「作废」标记的话，旧交易所的连接会在后台一直连回来（页面那侧的 wss 早摘了，
 * 纯粹耗着，还会把日志刷满）。这里直接构造一个 hub，关掉，再数 6 秒里的 connected 次数。
 */
{
  console.log('\n[dispose] 关掉之后不能自己连回来');
  const { BitgetMarketHub } = await import('../src/bitget/market.js');
  const hubWss = new WebSocketServer({ noServer: true });
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
  let hub: InstanceType<typeof BitgetMarketHub> | null = null;
  try {
    hub = new (BitgetMarketHub as unknown as new (wss: unknown) => InstanceType<typeof BitgetMarketHub>)(hubWss);
    hub.connect();
    const connected = await waitFor(() => lines.some((l) => l.includes('bitget connected')), 25_000);
    hub.close();
    const before = lines.filter((l) => l.includes('bitget connected')).length;
    await sleep(6000);
    const after = lines.filter((l) => l.includes('bitget connected')).length;
    console.log = origLog;
    console.warn = origWarn;
    ok('连接建起来过（前置条件）', connected, lines.join(' | '));
    ok('close() 之后没有再连回来', after === before, 'connected ' + before + '→' + after + '：' + lines.slice(-4).join(' | '));
    ok('close() 之后状态是「没连上」', hub.status().alive === false, JSON.stringify(hub.status()));
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    try { hub?.close(); } catch { /* 已关 */ }
    hubWss.close();
  }
}

console.log('');
if (failures) {
  console.error('✗ 行情自愈检查失败：' + failures + ' 项');
  process.exit(1);
}
console.log('✓ 行情自愈检查全部通过');
