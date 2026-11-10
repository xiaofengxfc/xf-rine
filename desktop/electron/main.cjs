'use strict';
/**
 * 桌面端外壳。
 *
 * 页面不是拷进来的静态文件，是服务端现成的 —— 主进程先把这个服务端拉起来，再打开窗口。
 * 这样代码只有一份：浏览器、手机 App、桌面窗口跑的是同一个前端、同一套接口。
 *
 * 装完之后的常见坑都在这个文件里处理掉了：
 *   - 端口被别的程序占着（换一个空的，记住它）
 *   - 安装目录是只读的（密钥文件写进用户目录）
 *   - 服务端进程莫名退出（自动重启，起不来就说清楚）
 *   - 用户目录里第一次没有配置（自动生成手机访问的口令）
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

/**
 * 冒烟模式：只启动服务端、等它健康，然后退出。用来在没有人工点击的机器上验证安装包。
 *
 * 走环境变量而不是命令行参数：Chromium 会把不认识的 --xxx 当成坏参数，
 * 直接以 "bad option" 退出，根本到不了这行代码。
 */
const SMOKE = process.env.XFRINE_SMOKE === '1' || process.argv.includes('--smoke');

let serverProc = null;
let serverPort = 0;
let serverHost = '0.0.0.0';
let win = null;
let restarts = 0;
let quitting = false;

// ---------- 路径 ----------

function dataDir() {
  const d = app.getPath('userData');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function serverScript() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'server.cjs')
    : path.join(__dirname, '..', 'out', 'server.cjs');
}

function webDistDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web-dist')
    : path.join(__dirname, '..', '..', 'web', 'dist');
}

// ---------- 日志 ----------

function logFile() {
  return path.join(dataDir(), 'app.log');
}

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(logFile(), line + '\n', 'utf8');
  } catch { /* 日志写不了不该拦住程序 */ }
}

/** 日志别无限长：超过 2MB 就从头开始 */
function trimLog() {
  try {
    const f = logFile();
    if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) fs.rmSync(f);
  } catch { /* 无所谓 */ }
}

// ---------- .env ----------

function envFile() {
  return path.join(dataDir(), '.env');
}

function readEnvText() {
  try {
    return fs.readFileSync(envFile(), 'utf8');
  } catch {
    return '';
  }
}

function envHas(text, name) {
  return new RegExp('^\\s*' + name + '\\s*=', 'm').test(text);
}

function readEnvNumber(text, name) {
  const m = new RegExp('^\\s*' + name + '\\s*=\\s*(\\d+)', 'm').exec(text);
  return m ? Number(m[1]) : 0;
}

function readEnvString(text, name) {
  const m = new RegExp('^\\s*' + name + '\\s*=\\s*(\\S+)', 'm').exec(text);
  return m ? m[1] : '';
}

function writeEnvLine(name, value) {
  const text = readEnvText();
  const line = name + '=' + value;
  const re = new RegExp('^\\s*' + name + '\\s*=.*$', 'm');
  const next = re.test(text) ? text.replace(re, line) : (text.replace(/\s*$/, '') + (text.trim() ? '\n' : '') + line + '\n');
  try {
    fs.writeFileSync(envFile(), next, 'utf8');
  } catch (e) {
    log('[main] 写 .env 失败：' + e.message);
  }
}

/**
 * 第一次运行时补齐手机访问需要的两项。
 *
 * HOST=0.0.0.0 才收得到手机上发来的请求；
 * REMOTE_TOKEN 是那道门锁 —— 不设的话服务端会拒绝启动，因为绑在局域网上又没有口令，
 * 等于把下单接口交给同一个 Wi-Fi 里的所有人。
 * 已经有值的一律不覆盖：用户自己改过的设置不能被升级冲掉。
 */
function ensureEnv() {
  let text = readEnvText();
  const add = [];
  if (!envHas(text, 'HOST')) add.push('HOST=0.0.0.0');
  if (!envHas(text, 'REMOTE_TOKEN')) add.push('REMOTE_TOKEN=' + randomBytes(9).toString('base64url'));
  if (add.length) {
    text = text.replace(/\s*$/, '') + (text.trim() ? '\n' : '') + add.join('\n') + '\n';
    try {
      fs.writeFileSync(envFile(), text, 'utf8');
      log('[main] 已生成配置文件：' + envFile());
    } catch (e) {
      log('[main] 写配置文件失败：' + e.message);
    }
  }
  serverHost = readEnvString(readEnvText(), 'HOST') || '0.0.0.0';
}

// ---------- 端口 ----------

function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/**
 * 挑一个能用的端口。
 *
 * 不用写死 8787：用户可能同时开着开发环境，别的程序也可能正好占了。
 * 上次用过的端口写在 .env 里，优先接着用 —— 手机端填的地址跟端口绑在一起，
 * 每次启动换一个的话，手机上那串就白填了。
 */
async function pickPort(preferred) {
  if (preferred && (await portFree(preferred, serverHost))) return preferred;
  for (const p of [8787, 8788, 8789, 8790, 8791]) {
    if (await portFree(p, serverHost)) return p;
  }
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, serverHost, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// ---------- 服务端进程 ----------

function spawnServer() {
  const script = serverScript();
  if (!fs.existsSync(script)) throw new Error('安装包里缺少服务端程序：' + script);

  const env = {
    ...process.env,
    // 让 Electron 的 exe 当成 node 来跑这个脚本：用户机器上不需要装 Node
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(serverPort),
    XFRINE_HOME: dataDir(),
    WEB_DIST: webDistDir(),
    NODE_ENV: 'production',
    // 告诉服务端「你的父进程死了就跟着退」，见 server/src/index.ts
    XFRINE_PARENT_PIPE: '1',
  };
  // 从别的 Electron 程序继承来的变量对子进程没意义，还可能干扰它
  delete env.ELECTRON_RUN_AS_NODE_INSPECT;

  // stdin 要开着：父进程一死，管道关掉，服务端收到 EOF 就自己退（不然会留孤儿占端口）
  const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (b) => log('[server] ' + b.trimEnd()));
  child.stderr.on('data', (b) => log('[server!] ' + b.trimEnd()));
  child.on('error', (e) => log('[main] 服务端进程起不来：' + e.message));
  child.on('exit', onServerExit);
  log('[main] 服务端已启动 pid=' + child.pid + ' port=' + serverPort);
  return child;
}

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    // 进程已经退了就别干等
    if (!serverProc) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 服务端掉了。
 * 用户视角是「页面突然全空了」，所以能重启就重启，
 * 重启不起来就把日志路径说出来，而不是留一个白窗口。
 */
function onServerExit(code, signal) {
  serverProc = null;
  if (quitting) return;
  log('[main] 服务端退出 code=' + code + ' signal=' + signal);

  if (restarts >= 3) {
    dialog.showErrorBox(
      '服务端起不来',
      '连续 ' + restarts + ' 次没能把服务端拉起来，程序退出。\n\n日志：' + logFile(),
    );
    app.quit();
    return;
  }
  restarts += 1;
  const delay = 700 * restarts;
  log('[main] ' + delay + 'ms 后第 ' + restarts + ' 次重启');
  setTimeout(async () => {
    if (quitting) return;
    try {
      serverPort = await pickPort(serverPort);
      serverProc = spawnServer();
      const ok = await waitHealth(20_000);
      if (!ok) log('[main] 重启后仍然不健康');
      if (win && !win.isDestroyed()) win.loadURL(urlFor());
    } catch (e) {
      log('[main] 重启失败：' + e.message);
    }
  }, delay);
}

function urlFor() {
  return 'http://127.0.0.1:' + serverPort + '/';
}

// ---------- 窗口 ----------

function createWindow(opts) {
  const hidden = Boolean(opts && opts.hidden);
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    backgroundColor: '#0c0e12',
    title: '巡风 · Gate 永续日内台',
    autoHideMenuBar: true,
    webPreferences: {
      // 页面就是普通的网页，不需要 Node，也不给原生能力
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.on('closed', () => { win = null; });

  // 页面里的外链（新闻、交易所网页）走系统浏览器，不在窗口里开着走
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:' + serverPort)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  // F12 打开开发者工具：手机上看着不对的排版，这里缩窗口就能对着调
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  // 服务端正好在重启时，窗口会加载失败一次。等一下自己再刷，别停在错误页上
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    log('[main] 页面加载失败 ' + code + ' ' + desc + ' ' + url);
    setTimeout(() => {
      if (win && !win.isDestroyed() && serverProc) win.loadURL(urlFor());
    }, 1200);
  });

  win.loadURL(urlFor());
  return win;
}

/**
 * 冒烟测试：不只是「服务端活着」，还要页面在窗口里真的渲染出来。
 *
 * 只等 /api/health 通是不够的 —— 前端产物路径写错、脚本报错，服务端照样是好的，
 * 用户看到的却是一块黑屏。这里真的开一个窗口、等 did-finish-load，
 * 再去问 DOM：#root 里有没有挂上东西。
 */
function runSmoke() {
  const w = createWindow({ hidden: true });
  let settled = false;

  const finish = (good, why) => {
    if (settled) return;
    settled = true;
    log('[main] SMOKE ' + (good ? 'OK' : 'FAIL') + (why ? '  ' + why : ''));
    console.log(good ? 'SMOKE_OK port=' + serverPort + ' home=' + dataDir() : 'SMOKE_FAIL ' + why);
    quitting = true;
    try { serverProc.kill(); } catch { /* 已经没了 */ }
    // 走 quit 而不是 exit：before-quit 里还有一道清理，exit 会跳过它
    process.exitCode = good ? 0 : 1;
    setTimeout(() => app.quit(), 300);
  };

  w.webContents.once('did-fail-load', (_e, code, desc) => finish(false, 'did-fail-load ' + code + ' ' + desc));

  w.webContents.once('did-finish-load', async () => {
    // React 挂载是异步的，给几秒
    for (let i = 0; i < 20; i += 1) {
      try {
        const ok = await w.webContents.executeJavaScript(
          "Boolean(document.getElementById('root') && document.getElementById('root').childElementCount > 0)",
        );
        if (ok) { finish(true, ''); return; }
      } catch { /* 页面还在加载 */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    finish(false, '#root 一直空着');
  });

  setTimeout(() => finish(false, '超时（25 秒没加载出来）'), 25_000);
}

// ---------- 启动 ----------

async function main() {
  Menu.setApplicationMenu(null);
  // Windows 的任务栏分组和通知用这个 id，别让它显示成 electron.app.Electron
  if (process.platform === 'win32') app.setAppUserModelId('com.xfrine.terminal');

  trimLog();
  ensureEnv();

  const preferred = readEnvNumber(readEnvText(), 'PORT');
  serverPort = await pickPort(preferred);
  if (serverPort !== preferred) {
    // 记住这次挑到的端口，下次接着用；手机端填的地址才不会每天都变
    writeEnvLine('PORT', String(serverPort));
  }
  log('[main] 端口 ' + serverPort + '（配置里是 ' + (preferred || '未设置') + '）');

  serverProc = spawnServer();
  const ok = await waitHealth(30_000);

  if (SMOKE) {
    if (!ok) {
      log('[main] SMOKE FAIL 服务端没起来');
      console.error('SMOKE_FAIL 服务端没起来');
      quitting = true;
      try { serverProc.kill(); } catch { /* 同上 */ }
      app.exit(1);
      return;
    }
    log('[main] SMOKE 服务端就绪，开始加载窗口');
    runSmoke();
    return;
  }

  if (!ok) {
    dialog.showErrorBox(
      '服务端没能启动',
      '端口 ' + serverPort + ' 上的服务端 30 秒内没有就绪。\n\n日志：' + logFile(),
    );
    quitting = true;
    app.quit();
    return;
  }

  createWindow();
}

// 只允许开一个：第二个窗口会和第一个抢端口，还会把锁写乱
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    main().catch((e) => {
      log('[main] 启动失败：' + (e && e.stack ? e.stack : e));
      if (!SMOKE) dialog.showErrorBox('启动失败', String(e && e.message ? e.message : e));
      app.exit(1);
    });
  });
}

app.on('window-all-closed', () => app.quit());

// 关窗口、任务管理器结束、安装程序替换文件：都要把子进程带走，
// 否则用户会留下一个占着端口的孤儿进程，下次启动以为「端口被占用」
app.on('before-quit', () => {
  quitting = true;
  if (serverProc) {
    try { serverProc.kill(); } catch { /* 已经没了 */ }
    serverProc = null;
  }
});
process.on('exit', () => {
  if (serverProc) {
    try { serverProc.kill(); } catch { /* 同上 */ }
  }
});
