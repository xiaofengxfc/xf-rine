/**
 * Python 引擎（sidecar）的进程管理与请求客户端。
 *
 * 为什么是子进程 + 回环 HTTP
 * --------------------------
 * 算法用上游原版 numpy/pandas 跑，才叫移植；Node 这边只做接口和界面。
 * 两边各管各的进程，Python 崩了不会把交易台拖下来，交易台的请求也进不了 Python 的解释器。
 *
 * 生命周期
 * --------
 *   * 懒启动：第一次真正要算的关键位请求才拉起，只想看盘的人不用付这份内存
 *   * 启动成功的判据是 stdout 上的 READY <port>，不是「进程还在」
 *   * 端口每次随机，口令每次随机，只绑 127.0.0.1
 *   * 进程意外退出会在下一次请求时重启；连续失败会进入冷却，避免疯狂拉起
 *   * 服务端退出时一并停掉（见 stopSidecar），不留孤儿 python.exe 占内存
 *
 * 部署形态（三种，按顺序找）
 * --------------------------
 *   1. XFRINE_SIDECAR 指向打包好的可执行文件（PyInstaller 产物，桌面安装版）
 *   2. XFRINE_SIDECAR 指向 sidecar 目录（里面有 service.py）
 *   3. 仓库里跑：向上找 sidecar/service.py，用 sidecar/.venv 的解释器
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { moduleDir } from '../config.js';

export class SidecarError extends Error {
  code: string;
  /** 没起来 / 正在冷却 —— 界面据此显示「引擎未就绪」而不是「算错了」 */
  unavailable: boolean;
  /**
   * 这次该回给调用方什么 HTTP 状态。
   *
   * 以前一律 500：引擎说「找不到数据文件」「缺少 dir 或 symbol」这种
   * **用户参数写错**，也被报成服务端故障 —— 页面弹红字，日志看着像引擎崩了，
   * 而真正要做的是换个品种或者补个参数。
   */
  httpStatus: number;
  constructor(code: string, message: string, unavailable = false, httpStatus = 500) {
    super(message);
    this.name = 'SidecarError';
    this.code = code;
    this.unavailable = unavailable;
    this.httpStatus = httpStatus;
  }
}

interface Launch {
  cmd: string;
  args: string[];
  cwd: string;
  /** 日志里用的可读描述 */
  label: string;
}

/** Node 侧进程状态 */
let child: ChildProcess | null = null;
let port = 0;
let token = '';
let ready: Promise<number> | null = null;
let stopping = false;
let lastError = '';
/** 引擎起不来时别每个请求都去拉一次：冷却期内直接报同一个原因 */
let cooldownUntil = 0;
const COOLDOWN_MS = 15_000;
const START_TIMEOUT_MS = 40_000;

function venvPython(root: string): string {
  return process.platform === 'win32'
    ? join(root, 'sidecar', '.venv', 'Scripts', 'python.exe')
    : join(root, 'sidecar', '.venv', 'bin', 'python');
}

/** 从若干起点往上找 sidecar/service.py（开发态、仓库根都可能） */
function findRepoRoot(): string | null {
  const starts = [moduleDir(), process.cwd()];
  for (const start of starts) {
    let dir = resolve(start);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, 'sidecar', 'service.py'))) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

function resolveLaunch(): Launch | null {
  const hint = (process.env.XFRINE_SIDECAR ?? '').trim();
  if (hint) {
    const abs = resolve(hint);
    if (existsSync(abs) && abs.toLowerCase().endsWith('.py')) {
      // 直接指到 service.py 上：解释器还得自己找
      const root = dirname(dirname(abs));
      const py = (process.env.XFRINE_PYTHON ?? '').trim() || venvPython(root);
      return { cmd: py, args: [abs], cwd: dirname(abs), label: 'python service.py' };
    }
    if (existsSync(join(abs, 'service.py'))) {
      const py = (process.env.XFRINE_PYTHON ?? '').trim() || venvPython(abs);
      return { cmd: py, args: [join(abs, 'service.py')], cwd: abs, label: 'python service.py' };
    }
    // 其余情形当成打包好的可执行文件
    return { cmd: abs, args: [], cwd: dirname(abs), label: abs };
  }

  const root = findRepoRoot();
  if (!root) return null;
  const script = join(root, 'sidecar', 'service.py');
  const custom = (process.env.XFRINE_PYTHON ?? '').trim();
  const venv = venvPython(root);
  const cmd = custom || (existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3'));
  return { cmd, args: [script], cwd: join(root, 'sidecar'), label: cmd + ' service.py' };
}

/** 停掉子进程（服务端退出时调） */
export function stopSidecar(): void {
  stopping = true;
  ready = null;
  port = 0;
  const c = child;
  child = null;
  if (!c) return;
  try { c.stdin?.end(); } catch { /* 已经关了 */ }
  try { c.kill(); } catch { /* 已经没了 */ }
}

function start(): Promise<number> {
  if (stopping) return Promise.reject(new SidecarError('STOPPING', '服务端正在退出', true));
  if (port && child && !child.killed) return Promise.resolve(port);
  if (ready) return ready;
  const embeddedUrl = (process.env.XFRINE_SIDECAR_URL ?? '').trim().replace(/\/+$/, '');
  if (embeddedUrl) {
    token = (process.env.XFRINE_SIDECAR_TOKEN ?? '').trim();
    if (!token) return Promise.reject(new SidecarError('TOKEN_REQUIRED', '内嵌关键位引擎缺少访问口令', true));
    ready = fetch(embeddedUrl + '/health', {
      headers: { 'x-sidecar-token': token },
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    }).then(async (response) => {
      if (!response.ok) {
        throw new SidecarError('EMBEDDED_UNAVAILABLE', '内嵌关键位引擎未就绪（HTTP ' + response.status + '）', true);
      }
      const parsedPort = Number(new URL(embeddedUrl).port);
      port = parsedPort > 0 ? parsedPort : 80;
      console.log('  关键位引擎  已就绪 ' + embeddedUrl);
      return port;
    }).catch((error: unknown) => {
      ready = null;
      if (error instanceof SidecarError) throw error;
      throw new SidecarError('EMBEDDED_UNAVAILABLE', '连接内嵌关键位引擎失败：' + (error as Error).message, true);
    });
    return ready;
  }
  const now = Date.now();
  if (now < cooldownUntil) {
    return Promise.reject(new SidecarError('COOLDOWN', lastError || '关键位引擎刚才起不来，稍后再试', true));
  }

  const launch = resolveLaunch();
  if (!launch) {
    lastError = '找不到 sidecar/service.py，也没配 XFRINE_SIDECAR';
    cooldownUntil = now + COOLDOWN_MS;
    return Promise.reject(new SidecarError('NOT_INSTALLED', lastError, true));
  }

  token = randomBytes(16).toString('hex');

  ready = new Promise<number>((res, rej) => {
    let settled = false;
    let buf = '';
    const fail = (code: string, msg: string) => {
      if (settled) return;
      settled = true;
      lastError = msg;
      cooldownUntil = Date.now() + COOLDOWN_MS;
      ready = null;
      try { proc.kill(); } catch { /* 已经没了 */ }
      rej(new SidecarError(code, msg, true));
    };

    let proc: ChildProcess;
    try {
      proc = spawn(launch.cmd, [...launch.args, '--port', '0', '--token', token], {
        cwd: launch.cwd,
        // stdin 留着：父进程一死它就关，Python 那边读到 EOF 自己退
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (e) {
      fail('SPAWN_FAIL', '启动关键位引擎失败：' + (e as Error).message);
      return;
    }
    child = proc;
    // 别让这个子进程钩住父进程的事件循环：Node 里子进程默认会让进程不退，
    // 命令行脚本（pnpm check:levels / check:data）跑完就一直挂着。
    // 服务端本来就常驻，unref 不影响它；退出时 stopSidecar 会主动收掉。
    proc.unref();

    const timer = setTimeout(() => {
      fail('START_TIMEOUT', '关键位引擎 40 秒没起来（' + launch.label + '）');
    }, START_TIMEOUT_MS);
    timer.unref?.();

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = /^READY (\d+)$/.exec(line);
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          port = Number(m[1]);
          console.log('  关键位引擎  已就绪 127.0.0.1:' + port);
          res(port);
          continue;
        }
        if (!/^(READY|  引擎|  概率模型|  校准表)/.test(line)) console.log('[sidecar] ' + line);
      }
    });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) console.warn('[sidecar] ' + text);
    });
    proc.on('error', (err) => {
      fail('SPAWN_FAIL', '关键位引擎启动失败：' + err.message);
    });
    proc.on('exit', (code, signal) => {
      const wasReady = settled && port > 0;
      child = null;
      port = 0;
      ready = null;
      if (settled) clearTimeout(timer);
      if (stopping) return;
      if (!settled) {
        fail('EXIT_EARLY', '关键位引擎启动即退出（code=' + code + ' signal=' + signal + '）：' + lastError);
      } else if (wasReady) {
        lastError = '关键位引擎意外退出（code=' + code + '）';
        cooldownUntil = Date.now() + COOLDOWN_MS;
        console.warn('[sidecar] ' + lastError + '，下次请求会重启');
      }
    });
  });

  return ready;
}

/** 确保引擎在跑，返回端口 */
export async function ensureReady(): Promise<number> {
  return start();
}

async function call<T>(path: string, params: Record<string, string | number | boolean | undefined>, timeoutMs: number, body?: unknown): Promise<T> {
  await ensureReady();
  const embeddedUrl = (process.env.XFRINE_SIDECAR_URL ?? '').trim().replace(/\/+$/, '');
  const url = new URL((embeddedUrl || 'http://127.0.0.1:' + port) + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-sidecar-token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 400) }; }
    if (!res.ok) {
      const j = json as { error?: string; type?: string };
      const message = j.error || '关键位引擎返回 ' + res.status;
      /**
       * 引擎自己报的是 4xx（参数不对、品种不存在），就原样带回去。
       * 只有它 5xx 才是「引擎算挂了」——那才值得当服务端故障。
       */
      const forward = res.status >= 400 && res.status < 500 ? res.status : 500;
      throw new SidecarError(j.type || 'HTTP_' + res.status, message, false, forward);
    }
    return json as T;
  } catch (e) {
    if (e instanceof SidecarError) throw e;
    const err = e as Error;
    if (err.name === 'AbortError') {
      throw new SidecarError('TIMEOUT', '关键位引擎 ' + Math.round(timeoutMs / 1000) + ' 秒没算完');
    }
    // 连不上：进程可能刚死，清掉状态让下次重新拉起
    port = 0;
    child = null;
    ready = null;
    throw new SidecarError('UNREACHABLE', '连不上关键位引擎：' + err.message, true);
  } finally {
    clearTimeout(timer);
  }
}

/** 引擎自检。顺便当作「装没装」的探测，失败不抛 */
export async function health(): Promise<{ ok: boolean; detail?: string; data?: unknown }> {
  try {
    const data = await call<unknown>('/health', {}, 8_000);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export interface AnalyzeParams {
  dir?: string;
  symbol: string;
  tf: string;
  window?: number;
  n_zones?: number;
  direction?: string;
  mtf?: boolean;
  n_bars?: number;
}

/** 本地数据目录：读文件 + 分析一条龙 */
export function analyzeLocal(p: AnalyzeParams): Promise<Analysis> {
  return call('/analyze', {
    dir: p.dir, symbol: p.symbol, tf: p.tf,
    window: p.window, n_zones: p.n_zones, direction: p.direction,
    mtf: p.mtf === undefined ? undefined : (p.mtf ? '1' : '0'),
    n_bars: p.n_bars,
  }, 90_000);
}

/** 交易所实时行情：K 线由 Node 给（主周期 + 邻居周期） */
export function analyzeBars(input: {
  symbol: string;
  tf: string;
  frames: { tf: string; bars: SidecarBar[] }[];
  n_zones?: number;
  direction?: string;
  mtf?: boolean;
  tick?: number;
}): Promise<Analysis> {
  return call('/analyze_bars', {}, 90_000, input);
}

/** 本地数据：原始 K 线（图表用） */
export function localBars(dir: string, symbol: string, tf: string, limit: number): Promise<{
  symbol: string; tf: string; bars: SidecarBar[]; total: number; returned: number;
}> {
  return call('/bars', { dir, symbol, tf, limit }, 60_000);
}

export function instruments(dir: string): Promise<InstrumentsResult> {
  return call('/instruments', { dir }, 30_000);
}

export function scan(dir: string, p: { tf: string; window?: number; n_zones?: number; direction?: string }): Promise<ScanResult> {
  return call('/scan', { dir, tf: p.tf, window: p.window, n_zones: p.n_zones, direction: p.direction }, 600_000);
}

import type { Analysis, InstrumentsResult, ScanResult, SidecarBar } from './types.js';
