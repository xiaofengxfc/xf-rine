/**
 * 用「真正的」Node 跑 electron-builder。
 *
 * 这里要处理两件和代码无关、但每次打包都会撞上的事：
 *
 * 一、Node 路径。
 * 这台机器 PATH 上的 node 是 DSH 的 node.cmd（转发到 DSH Desktop.exe），它会把 --win --x64
 * 当成 Electron 自己的开关吃掉，electron-builder 只收到一个裸路径，报「Unknown argument: .../cli.js」。
 * 所以显式挑一个：XFRINE_NODE > D:\tool\node\node.exe > 当前进程（前提是它本身不是 Electron）。
 *
 * 二、代理。
 * electron-builder 从 GitHub 取 Electron 的压缩包和 winCodeSign 这些东西，走的是它自己的 got。
 * Node 不读系统代理，于是这台开着代理的机器上打包会报：
 *   ⨯ connect ETIMEDOUT 20.205.243.166:443  failedTask=build
 * 同一台机器上浏览器和 PowerShell 都好好的 —— 看着像网络坏了，其实只是没告诉它走代理。
 * 环境里已经写了 HTTPS_PROXY 就用环境里的；没写就去读一次 Windows 的系统代理，
 * 和 server/src/net.ts 那套读法是同一个来源（程序别的地方也这么跟系统代理）。
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(pkgDir, 'package.json'));
const cli = require.resolve('electron-builder/cli.js');

const insideElectron = Boolean(process.versions.electron);
const candidates = [process.env.XFRINE_NODE, 'D:\\tool\\node\\node.exe', insideElectron ? null : process.execPath];
const node = candidates.filter(Boolean).find((p) => existsSync(p));
if (!node) {
  console.error('找不到可用的 Node：请设置 XFRINE_NODE 指向 node.exe');
  process.exit(1);
}

/** 读一个注册表值（读不到就是空串，不抛） */
function regValue(name) {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const m = new RegExp(name + '\\s+REG_[A-Z_]+\\s+(.+)', 'm').exec(out);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * 系统代理给的写法五花八门：
 *   127.0.0.1:2080
 *   http=127.0.0.1:2080;https=127.0.0.1:2081
 *   http://127.0.0.1:2080
 * 统一成一个地址，https 那项优先（和服务端那边同一套规则）。
 */
function pickProxy(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  const parts = text.split(';').map((s) => s.trim()).filter(Boolean);
  let pick = '';
  for (const part of parts) {
    const eq = part.indexOf('=');
    const key = eq >= 0 ? part.slice(0, eq).trim().toLowerCase() : '';
    const value = (eq >= 0 ? part.slice(eq + 1) : part).trim();
    if (!value) continue;
    if (key === 'https') { pick = value; break; }
    if (!pick && (key === 'http' || key === '')) pick = value;
  }
  if (!pick) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(pick) ? pick : 'http://' + pick;
}

/** 该给子进程哪个代理地址（空串表示直连） */
function resolveProxy() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (fromEnv.trim()) return { url: pickProxy(fromEnv), source: '环境变量' };
  if (process.platform !== 'win32') return { url: '', source: '' };
  const enabled = (regValue('ProxyEnable') || '').toLowerCase();
  if (enabled !== '0x1' && enabled !== '1') return { url: '', source: '' };
  const url = pickProxy(regValue('ProxyServer'));
  return url ? { url, source: '系统代理' } : { url: '', source: '' };
}

const proxy = resolveProxy();
const env = { ...process.env };
if (proxy.url) {
  // ELECTRON_GET_USE_PROXY 是 @electron/get 的开关：不开的话它连环境变量里的代理都不看
  env.HTTPS_PROXY = proxy.url;
  env.HTTP_PROXY = proxy.url;
  env.ELECTRON_GET_USE_PROXY = '1';
  console.log('electron-builder 用 ' + node + '（下载走' + proxy.source + ' ' + proxy.url + '）');
} else {
  console.log('electron-builder 用 ' + node + '（直连，没有代理）');
}

// 第一次失败多半是 GitHub 那边抖一下（连接超时、TLS 断开），原样再来一次往往就过了。
// 打包本身是幂等的：每次都会重写 release 里的产物，失败的那次不会留下半成品。
function attempt() {
  const r = spawnSync(node, [cli, '--win', '--x64', '--config', 'electron-builder.yml'], {
    cwd: pkgDir,
    stdio: 'inherit',
    env,
  });
  return r.status ?? 1;
}

let status = attempt();
if (status !== 0) {
  console.error('');
  console.error('第一次打包失败（退出码 ' + status + '）。如果上面是 connect ETIMEDOUT / ECONNRESET 这类');
  console.error('连不上 GitHub 的报错，先确认代理还在跑；下面再试一次。');
  console.error('');
  status = attempt();
}
process.exit(status);
