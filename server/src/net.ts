import { execFile } from 'node:child_process';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { restBaseUrl } from './config.js';

type FetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

export interface ProxyState {
  /** 服务端出网有没有走代理 */
  on: boolean;
  /** http://127.0.0.1:2080 */
  url: string;
  /** env = 环境变量，system = Windows 系统代理，direct = 直连 */
  source: 'env' | 'system' | 'direct';
  /** 代理配着却连不通时的原因 */
  error?: string;
  /** 上一次因为 Gate 的 IP 白名单退回直连的时刻 */
  blockedAt?: number;
  /** 这次结论是什么时候得出的 */
  at: number;
}

/** 白名单拒绝之后，私有请求先直连一会儿，过 5 分钟再试代理 */
const BLOCK_TTL_MS = 5 * 60_000;
let blockedAt = 0;

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 读注册表的一项。读不到就给空串，不让它抛。 */
function regValue(name: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('reg', ['query', REG_KEY, '/v', name], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(''); return; }
      const m = new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.+)`, 'm').exec(stdout);
      resolve(m ? m[1]!.trim() : '');
    });
  });
}

/**
 * 系统代理给的写法五花八门：
 *   127.0.0.1:2080
 *   http=127.0.0.1:2080;https=127.0.0.1:2081
 *   http://127.0.0.1:2080
 * 统一成后面要用的一个地址，https 那项优先。
 */
function pickProxy(raw: string): string {
  const text = raw.trim();
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
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(pick) ? pick : `http://${pick}`;
}

/**
 * 服务端该走哪个代理。环境变量优先，其次 Windows 系统代理。
 * Node 自己不读系统代理，所以这里替它读一次。
 */
async function detectProxy(): Promise<{ url: string; source: ProxyState['source'] }> {
  const env = (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? '').trim();
  if (env) {
    const url = pickProxy(env);
    if (url) return { url, source: 'env' };
  }
  if (process.platform !== 'win32') return { url: '', source: 'direct' };

  const enabled = (await regValue('ProxyEnable')).toLowerCase();
  if (enabled !== '0x1' && enabled !== '1') return { url: '', source: 'direct' };
  const url = pickProxy(await regValue('ProxyServer'));
  return url ? { url, source: 'system' } : { url: '', source: 'direct' };
}

const direct: Dispatcher = new Agent({ connect: { timeout: 10_000 } });
let current: Dispatcher = direct;
let state: ProxyState = { on: false, url: '', source: 'direct', at: 0 };
/** 连续失败次数。代理进程关了但注册表还写着的时候，靠它自动退回直连 */
let failures = 0;

/** 代理配着不代表能用：代理进程可能已经退出，注册表还没清。探一次真的能不能出网。 */
async function probe(agent: Dispatcher): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await undiciFetch(`${restBaseUrl()}/api/v4/futures/usdt/contracts/BTC_USDT`, {
      dispatcher: agent,
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 重新确认代理状态。force 为真时即便地址没变也重新探一次。
 * 定时调它，用户换了代理、关了代理都能跟上，不需要重启服务。
 */
export async function refreshProxy(force = false): Promise<ProxyState> {
  const found = await detectProxy();
  // 手里没在走代理时必须重探：代理后开、或者一会儿才连上，都得自动切过去
  if (!force && state.at > 0 && found.url === state.url && state.on) return state;

  if (!found.url) {
    current = direct;
    state = { on: false, url: '', source: 'direct', at: Date.now() };
    return state;
  }

  // 代理地址不让它连自己，避免把本地代理进程搅进循环
  const agent = new ProxyAgent(found.url);
  const ok = await probe(agent);
  current = ok ? agent : direct;
  failures = 0;
  state = {
    on: ok,
    url: found.url,
    source: found.source,
    at: Date.now(),
    ...(ok ? {} : { error: '代理配着但连不通，先用直连' }),
    ...(blockedAt > 0 ? { blockedAt } : {}),
  };
  // 一次探不通多半是代理刚启动或者节点在切换，15 秒后再试，别一整天都直连
  if (!ok) setTimeout(() => { void refreshProxy(true); }, 15_000).unref();
  return state;
}

export function proxyState(): ProxyState {
  // 服务刚起来、第一次被问到时探测还没跑完，这里补一脚
  if (state.at === 0) void refreshProxy(true);
  return state;
}

/**
 * 出网都走这里：配了代理就走代理。
 *
 * 两种自动降级：
 *   1. 代理断了：这一次退回直连做完，连续两次失败就整体切回直连，30 秒后再探；
 *   2. Gate 的白名单不认代理地址（403 + Request IP not in whitelist）：私有请求退回直连，
 *      5 分钟内不再拿代理去撞这堵墙。把代理 IP 加进白名单就能自己恢复。
 */
export async function netFetch(
  url: string,
  init: FetchInit = {},
  opts: { private?: boolean; direct?: boolean; preferDirect?: boolean } = {},
): Promise<ReturnType<typeof undiciFetch>> {
  const blocked = opts.private === true && blockedAt > 0 && Date.now() - blockedAt < BLOCK_TTL_MS;
  if (opts.direct === true || !state.on || blocked) return undiciFetch(url, { ...init, dispatcher: direct });

  // 优先直连：Gate 这类目标直连最快，代理只当直连不通时的后路。
  // 只有查询类请求可以这样重试：下单、撤单重发一遍可能变成两单。
  if (opts.preferDirect === true) {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return undiciFetch(url, { ...init, dispatcher: direct });
    try {
      return await undiciFetch(url, { ...init, dispatcher: direct });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      return await undiciFetch(url, { ...init, dispatcher: current });
    }
  }

  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, { ...init, dispatcher: current });
    failures = 0;
  } catch (err) {
    failures += 1;
    if (failures >= 2) {
      current = direct;
      state = { ...state, on: false, error: err instanceof Error ? err.message : String(err), at: Date.now() };
      setTimeout(() => { void refreshProxy(true); }, 30_000).unref();
    }
    return undiciFetch(url, { ...init, dispatcher: direct });
  }

  // 403 是「这一单没被受理」，改直连重发不会重复成交
  if (res.status === 403) {
    const text = await res.clone().text().catch(() => '');
    if (/not in whitelist/i.test(text)) {
      blockedAt = Date.now();
      state = { ...state, blockedAt, at: Date.now() };
      return undiciFetch(url, { ...init, dispatcher: direct });
    }
  }
  return res;
}
