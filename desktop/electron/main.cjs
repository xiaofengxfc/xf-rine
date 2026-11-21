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
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { envHas, readEnvNumber, setEnvLine, withNetworkDefaults } = require('./environment.cjs');
const { pickPort } = require('./port-selection.cjs');

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

/**
 * 这一份服务端的标记。
 *
 * 端口上可能有别人（开发环境、上一个没退干净的实例），光看「有 200 返回」分不清是谁。
 * 每次启动生成一个，交给子进程，再由 /api/health 带回来 —— 对不上就不是我们的，换端口。
 */
const INSTANCE = randomBytes(8).toString('hex');

// ---------- 路径 ----------

/**
 * 开发态（pnpm -F desktop start）用另一套用户目录。
 *
 * 不分开的话，仓库里跑起来的这个和装好的那个读同一份 .env、同一份 localStorage ——
 * 调样式时改坏一个设置，装好的那份跟着变，反过来也一样。
 * 安装版用产品名的目录（%APPDATA%\\巡风），开发态在后面加 -dev。
 */
if (!app.isPackaged) {
  try {
    app.setPath('userData', app.getPath('userData') + '-dev');
  } catch { /* 改不了就用默认的 */ }
}

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

/**
 * 关键位引擎（Python sidecar）在哪。
 *
 * 安装版里是 PyInstaller 打出来的 exe，跟着 resources 一起装进来；
 * 开发态不设这个变量 —— 服务端会自己去仓库里找 sidecar/service.py 和 .venv 的解释器。
 */
function sidecarExe() {
  if (!app.isPackaged) return '';
  const p = path.join(process.resourcesPath, 'sidecar', 'xfrine-sidecar.exe');
  return fs.existsSync(p) ? p : '';
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

function writeEnvLine(name, value) {
  const next = setEnvLine(readEnvText(), name, value);
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
  const current = readEnvText();
  const token = envHas(current, 'REMOTE_TOKEN') ? '' : randomBytes(9).toString('base64url');
  const settings = withNetworkDefaults(current, token);
  if (settings.text !== current) {
    try {
      fs.writeFileSync(envFile(), settings.text, 'utf8');
      log('[main] 已生成配置文件：' + envFile());
    } catch (e) {
      log('[main] 写配置文件失败：' + e.message);
    }
  }
  serverHost = settings.host;
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
    XFRINE_INSTANCE: INSTANCE,
    XFRINE_HOME: dataDir(),
    WEB_DIST: webDistDir(),
    NODE_ENV: 'production',
    // 告诉服务端「你的父进程死了就跟着退」，见 server/src/index.ts
    XFRINE_PARENT_PIPE: '1',
  };
  // 引擎的位置：没打进包（或干脆没打包引擎）就不设，服务端会去找仓库里的那份并报「未就绪」
  const engine = sidecarExe();
  if (engine) env.XFRINE_SIDECAR = engine;
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

/**
 * 等自己这一份服务端就绪。
 *
 * 返回 'ok' 才算数：端口上回 200 的可能是别人（开发环境、上一个实例、别的程序），
 * 接上去就成了别人的数据 —— 用户在安装版里改密钥，写进去的是项目的 server/.env。
 */
async function waitOurs(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        return String(body.instance ?? '') === INSTANCE ? 'ok' : 'foreign';
      }
    } catch { /* 还没起来 */ }
    // 进程已经退了就别干等
    if (!serverProc) return 'down';
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'down';
}

/** 收掉当前这一份服务端，并且不让它的退出触发重启 */
function stopServer() {
  const p = serverProc;
  serverProc = null;
  if (!p) return;
  try { p.removeListener('exit', onServerExit); } catch { /* 已经没了 */ }
  try { p.kill(); } catch { /* 同上 */ }
}

/**
 * 挑端口 → 起子进程 → 确认「这是我这一份」。
 *
 * 端口被别的程序占着（尤其是只绑 127.0.0.1 的开发服务）时，Windows 会让
 * 我们的 0.0.0.0 绑定也成功，然后页面连到的是对方。所以这里有三道：
 * 先连一下、再试绑、最后对标记。任何一道过不去就换下一个端口。
 */
async function startServer() {
  const preferred = readEnvNumber(readEnvText(), 'PORT');
  const skip = new Set();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    serverPort = await pickPort(attempt === 0 ? preferred : 0, skip, serverHost);
    if (attempt === 0 && serverPort !== preferred) {
      // 记住这次挑到的端口，下次接着用；手机端填的地址才不会每天都变
      writeEnvLine('PORT', String(serverPort));
    }
    log('[main] 端口 ' + serverPort + '（配置里是 ' + (preferred || '未设置') + '）');
    serverProc = spawnServer();
    const r = await waitOurs(30_000);
    if (r === 'ok') return true;
    if (r === 'foreign') {
      log('[main] ' + serverPort + ' 上回话的不是我们自己的服务端（多半是开发环境占了），换一个端口');
      stopServer();
      skip.add(serverPort);
      continue;
    }
    log('[main] 服务端没起来');
    return false;
  }
  log('[main] 连着几个端口都不是自己的，放弃');
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
      const ok = await startServer();
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
        const state = await w.webContents.executeJavaScript(
          "({ title: document.title, mounted: Boolean(document.getElementById('root') && document.getElementById('root').childElementCount > 0) })",
        );
        // 页面对了才算过：端口上要是坐着别人的页面，DOM 一样是满的
        if (state && state.mounted && String(state.title).includes('巡风')) { finish(true, ''); return; }
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

  const ok = await startServer();

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
