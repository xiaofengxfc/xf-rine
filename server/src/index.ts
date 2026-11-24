import express from 'express';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { allowedOrigin, isLoopbackAddress } from './httpSecurity.js';
import { config, keyHint, restBaseUrl, envLabel, exchangeLabel, ENV_PATH, lanEnabled, lanUrls, moduleDir } from './config.js';
import { router } from './routes.js';
// 行情连接跟着所选交易所走：Gate 一套、Bitget 一套，对页面是同一个协议
import { attachMarketHub, marketHubStatus, closeMarketHub } from './exchange/index.js';
import { stopSidecar } from './sr/client.js';
import { primeProxy, refreshProxy, proxyState, routeStats } from './net.js';
import { APP_VERSION, checkUpdate, openAsset } from './update.js';

const app = express();
/**
 * 备份包里面有密钥、策略库和画线，base64 之后几百 KB 很常见。
 * 这条要排在全局那个 256kb 的解析器前面 —— 排在后面等于一次都过不去。
 */
app.use('/api/backup', express.json({ limit: '16mb' }));
app.use(express.json({ limit: '256kb' }));

/**
 * 手机端（以及任何装在 WebView 里的页面）访问时的跨域。
 *
 * Capacitor 页面从 http://localhost 读取，服务端可能在本机手机，也可能在远程电脑，
 * 两者的源不一样 —— 少了这几个头，浏览器连请求都不发。
 *
 * 但不能回 *：本机这个端口后面是下单、平仓、改密钥，而浏览器对 127.0.0.1 的
 * 请求没有同源保护以外的任何防线 —— 别人的网页只要发一个跨域请求就能打到
 * /api/trade/arm 和 /api/order（还有 /api/config/keys）。所以只回显「自己人」的源：
 * 回环地址（桌面窗口 / 本地 Vite / Capacitor 都是这个），或者与请求 Host 相同的局域网 IP 字面量。
 * 别的源一律不给头，写操作直接 403。
 */
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    // Account, position and PnL snapshots change independently of the page URL.
    // Browsers and embedded WebViews must revalidate each live API poll.
    res.setHeader('Cache-Control', 'no-store');
  }
  const origin = String(req.header('origin') ?? '');
  const allowed = allowedOrigin(origin, String(req.header('host') ?? ''));
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
  } else if (origin && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.status(403).json({ error: 'BAD_ORIGIN', detail: '这个页面不是本机的，改数据的请求一律不办' });
    return;
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, x-arm-token, x-remote-token');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

/** 定长比较，别让「一位一位试」从响应时间里读出答案 */
function tokenOk(given: string): boolean {
  const want = config.remoteToken;
  if (!want) return true;
  if (!given || given.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

/**
 * 口令是不是连本机也拦。
 *
 * 电脑上是「只听回环」的，从别的机器来的才要口令；本机浏览器和桌面窗口不受影响。
 * 手机 App 不是这个情况：服务端就绑在 127.0.0.1:8787，而 Android 上的回环是整个设备共用的，
 * 同一台手机里别的应用也能摸到这个端口 —— 那后面是下单和密钥。
 * 所以手机上要求「连本机也带口令」，口令每次启动随机生成，只给 App 自己的页面。
 */
const requireToken = process.env.XFRINE_REQUIRE_TOKEN === '1';

/**
 * 手机访问的口令。
 *
 * 绑在 0.0.0.0 上之后，同一个 Wi-Fi 里的任何设备都能连到这个端口，
 * 而端口后面是下单、平仓、撤单 —— 没有口令等于把仓位交给整栋楼。
 *
 * 平时只拦「从别的机器来的」请求：桌面窗口和本机浏览器走的是回环地址，不受影响。
 * 手机上连本机也要拦，那种情形由上面的 requireToken 打开。
 */
app.use('/api', (req, res, next) => {
  if (!requireToken && (!lanEnabled() || isLoopbackAddress(req.socket.remoteAddress ?? ''))) {
    next();
    return;
  }
  const given = String(req.header('x-remote-token') ?? req.query.token ?? '');
  if (tokenOk(given)) {
    next();
    return;
  }
  res.status(401).json({ error: 'REMOTE_TOKEN_REQUIRED', detail: '这台服务端只接受带访问口令的连接，口令在电脑的设置页里' });
});

app.use('/api', router);

/**
 * 自动更新：查版本、下载安装包。
 *
 * 查的是 GitHub 的 Release，公开仓库匿名读取就够（私有 fork 可以带令牌，见 update.ts）。
 * 平台由客户端报上来：桌面端和安卓要的包不一样。
 *
 * 下载走服务端中转，不让客户端直接拿 GitHub 的地址：服务端本来就会挑直连还是代理出网
 * （net.ts），一百多兆的包也能跟着走对路；客户端那边也不必处理跨域和重定向。
 */

/** 查更新失败的日志：同一个原因十分钟说一次，免得离线时每次启动都刷 */
let lastUpdateError = '';
let lastUpdateErrorAt = 0;

app.get('/api/update/check', async (req, res) => {
  const platform = req.query.platform === 'android' ? 'android' : 'win';
  try {
    const result = await checkUpdate({ current: APP_VERSION, platform });
    if (result.error && (result.error !== lastUpdateError || Date.now() - lastUpdateErrorAt > 10 * 60_000)) {
      lastUpdateError = result.error;
      lastUpdateErrorAt = Date.now();
      console.warn('[update] 查更新失败：' + result.error);
    }
    res.json(result);
  } catch (err) {
    // 查更新失败不该在页面上弹错误：离线、限流都会走到这里，静默跳过就行
    console.warn('[update] 检查更新失败：' + (err instanceof Error ? err.message : String(err)));
    res.json({ enabled: true, current: APP_VERSION, latest: null, self: null, error: 'CHECK_FAILED' });
  }
});

app.get('/api/update/download', async (req, res) => {
  const platform = req.query.platform === 'android' ? 'android' : 'win';
  const version = String(req.query.version ?? '').trim();
  if (!version) {
    res.status(400).json({ error: 'VERSION_REQUIRED', detail: '缺少要下载的版本号' });
    return;
  }
  // 客户端断开（关窗口、取消下载）就把上游也掐掉，别在后台白拉一百多兆
  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  try {
    const opened = await openAsset({ version, platform, signal: ctl.signal });
    if (!opened) {
      res.status(404).json({ error: 'NOT_FOUND', detail: '这个版本没有对应平台的安装包' });
      return;
    }
    const { asset, upstream } = opened;
    res.setHeader('content-type', 'application/octet-stream');
    if (asset.size > 0) res.setHeader('content-length', String(asset.size));
    res.setHeader('content-disposition', 'attachment; filename="' + asset.name.replace(/["\\\r\n]/g, '') + '"');
    if (!upstream.body) {
      res.status(502).json({ error: 'UPSTREAM_EMPTY', detail: '上游没有返回安装包内容' });
      return;
    }
    const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    stream.on('error', (err) => {
      console.warn('[update] 安装包下载中断：' + (err instanceof Error ? err.message : String(err)));
      res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[update] 下载安装包失败：' + message);
    if (!res.headersSent) res.status(502).json({ error: 'DOWNLOAD_FAILED', detail: message });
    else res.destroy();
  }
});

/**
 * 健康检查。
 *
 * instance 是外壳启动子进程时给的随机标记，原样带回去。
 * 只有它能证明「这个端口上的服务端是我这一份」—— 开发环境、上一个没退干净的实例
 * 都可能正好在同一个端口上，光看 200 分不出来，页面接上去就成了别人的数据。
 */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), instance: process.env.XFRINE_INSTANCE ?? '' });
});

// 生产模式：直接托管已打包的前端。
// 桌面端把 web/dist 放在 resources/web-dist，用 WEB_DIST 指过来；
// 开发时还是往上两级找 web/dist。
/** 手机端只有接口：页面由 App 自己从内置资源里发，不需要（也不该）在这里再托管一份 */
const apiOnly = process.env.XFRINE_API_ONLY === '1';

const webDist = (process.env.WEB_DIST ?? '').trim() || resolve(moduleDir(), '../../web/dist');
if (apiOnly) {
  // 什么都不做：只提供 /api 和 /ws
} else if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(resolve(webDist, 'index.html'));
  });
} else {
  // 少了前端产物的话页面会是一片空白，什么线索都没有。
  console.error('[fatal] 找不到前端产物：' + webDist);
}

// 出网跟着系统代理走。Node 自己不读系统代理，这里替它读，并每分钟重新确认一次 ——
// 用户开关代理、换节点之后不用重启服务。
void primeProxy().then((p) => {
  console.log('  出网      ' + (p.on ? '走代理 ' + p.url + '（' + p.source + '）' : '直连') + (p.error ? '  ' + p.error : ''));
});
// 两条路谁快，量出来再决定每次请求走哪条（这里只打印，决策在 net.ts 里）
setTimeout(() => {
  const s = routeStats();
  console.log('  出网实测  直连 ' + (s.direct || '-') + 'ms / 代理 ' + (s.proxy || '-') + 'ms');
}, 6000).unref();
setInterval(() => { void refreshProxy(); }, 60_000).unref();

/**
 * /api 下没匹配到的路径回 JSON，不要落到 Express 默认的 HTML 错误页。
 *
 * 必须放在**所有** /api 路由之后：放在 `app.use('/api', router)` 后面就错了 ——
 * /api/health、/api/update/* 这些是挂在 app 上的，会被这条中间件提前吞掉，
 * 健康检查直接 404（我踩过这一次）。
 *
 * 为什么要它：页面所有请求都按 JSON 解析，拿到一段 HTML 时报的是
 * 「Unexpected token <」，和真正的原因（接口名写错了）毫无关系。
 */
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    detail: '没有这个接口：' + req.method + ' ' + req.originalUrl.split('?')[0],
  });
});

const server = createServer(app);

// WebSocket 也过同一道口令。浏览器升级请求带不了自定义头，所以口令走查询参数。
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info, cb) => {
    if (!requireToken && (!lanEnabled() || isLoopbackAddress(info.req.socket.remoteAddress ?? ''))) return cb(true);
    let token = '';
    try {
      token = new URL(info.req.url ?? '/', 'http://localhost').searchParams.get('token') ?? '';
    } catch { /* 地址畸形就当没带口令 */ }
    if (tokenOk(token)) return cb(true);
    cb(false, 401, 'Unauthorized');
  },
});
// 等代理探完再连：直连被重置的网络里，先连一次只会白掉一次线、白推一次 gate_down
void primeProxy().then(() => attachMarketHub(wss));

/**
 * 行情心跳播报：掉线说一次就够，别每 30 秒刷一行。
 *
 * 重连由 hub 自己负责（换路、退避都在那边），这里只负责让人知道「现在是断的」。
 * 断着的时候每 5 分钟提醒一次，页面顶上那颗点也还是红的。
 */
let wasAlive = true;
let lastDownLogAt = 0;
setInterval(() => {
  const s = marketHubStatus();
  if (s.alive) { wasAlive = true; return; }
  const now = Date.now();
  if (!wasAlive && now - lastDownLogAt < 5 * 60_000) return;
  wasAlive = false;
  lastDownLogAt = now;
  console.warn('[ws] ' + config.exchange + ' 行情掉线，正在重连…');
}, 30_000).unref();

/**
 * 绑在 0.0.0.0 上却没有口令，等于把交易接口挂到局域网上裸奔。
 * 这种配置直接拒绝启动，比启动之后让人以为「只是手机上连不上」强。
 */
if (lanEnabled() && !config.remoteToken) {
  console.error('  [fatal] HOST=' + config.host + ' 是给手机开的门，必须同时设 REMOTE_TOKEN，否则拒绝启动。');
  process.exit(1);
}

// 手机 App 里要求「连本机也带口令」，那就必须真有口令，否则这道门形同虚设
if (requireToken && !config.remoteToken) {
  console.error('  [fatal] XFRINE_REQUIRE_TOKEN=1 但没有 REMOTE_TOKEN，拒绝启动。');
  process.exit(1);
}

// 端口被占（比如另一个实例、或者开发时的服务还开着）时说清楚，别只抛一句 EADDRINUSE。
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error('  [fatal] 端口 ' + config.port + ' 已经被占用，换一个 PORT 再启动。');
  } else {
    console.error('  [fatal] 服务端启动失败：', err);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const k = keyHint();
  console.log('');
  console.log('  巡风日内台  http://127.0.0.1:' + config.port);
  console.log('  交易所    ' + exchangeLabel() + '  ' + restBaseUrl());
  console.log('  环境      ' + envLabel());
  console.log('  密钥      ' + (k.configured ? '已配置 ' + k.hint : '未配置（只能看盘，不能下单）'));
  console.log('  下单      ' + (config.liveTrading ? '已开启' + (config.env === 'live' ? ' —— 用的是真钱，谨慎' : '（模拟盘假钱）') : '关闭（只读）'));
  console.log('  配置      ' + ENV_PATH);
  console.log('  更新      版本 ' + (APP_VERSION || '未知') + '，启动时查一次 GitHub Release');
  if (lanEnabled()) {
    const urls = lanUrls(config.port);
    console.log('  手机      ' + (urls.length ? urls.join('  ') : '没找到局域网地址（没连 Wi-Fi？）'));
    console.log('           口令 ' + (config.remoteToken ? config.remoteToken.slice(0, 2) + '••••' + config.remoteToken.slice(-2) : '未设置'));
  }
  console.log('');
});

const bye = () => {
  closeMarketHub();
  server.close();
  // 引擎是子进程：不主动停，Node 退出后它会变成孤儿占着内存
  stopSidecar();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

/**
 * 桌面端把服务端当子进程拉起。
 *
 * 主进程要是被强杀（任务管理器结束进程、安装程序替换文件、崩溃），
 * 子进程会活下来占着端口 —— 下一次启动就变成「端口被别的程序占用」，
 * 用户看到的是一连串莫名其妙的端口号。
 *
 * 主进程一死，管道另一端就关了，stdin 收到 EOF，这里跟着退。
 * 只在桌面端显式要求时开（XFRINE_PARENT_PIPE=1）：从终端跑的时候 stdin 是 tty，
 * 有些环境里它也是管道，不设这个开关就可能在启动瞬间直接退出。
 */
if (process.env.XFRINE_PARENT_PIPE === '1') {
  process.stdin.on('end', bye);
  process.stdin.on('close', bye);
  process.stdin.on('error', bye);
  process.stdin.resume();
}

/**
 * 一个漏网的异常不该让整个台子停掉。
 * 进程一死，页面不会自己发现 —— 它继续显示最后一帧持仓和均价，看着就像「线画错了」。
 * 记下来、继续跑；页面那边也会在数据停更时直说。
 */
process.on('uncaughtException', (err) => {
  console.error('[fatal] 未捕获的异常，进程继续运行：', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[fatal] 未处理的 Promise 拒绝，进程继续运行：', err);
});
