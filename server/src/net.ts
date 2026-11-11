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

/**
 * 手上那个代理 agent，和它对应的地址。
 *
 * ProxyAgent 自带连接池。每次确认代理都新建一个、旧的直接扔，代理连着不通的时候
 * （注册表还写着、代理进程已经退了）15 秒一轮的重试会一直漏下去 —— 挂一晚上就是几百个连接池。
 * 地址没变就接着用同一个；地址变了才换，换的时候把旧的关掉。
 */
let proxyAgent: ProxyAgent | null = null;
let proxyAgentUrl = '';

function agentForProxy(url: string): ProxyAgent {
  if (proxyAgent && proxyAgentUrl === url) return proxyAgent;
  dropProxyAgent();
  proxyAgent = new ProxyAgent(url);
  proxyAgentUrl = url;
  return proxyAgent;
}

function dropProxyAgent(): void {
  const old = proxyAgent;
  proxyAgent = null;
  proxyAgentUrl = '';
  if (old) { try { void old.close(); } catch { /* 关不掉就算了 */ } }
}
let state: ProxyState = { on: false, url: '', source: 'direct', at: 0 };
/** 连续失败次数。代理进程关了但注册表还写着的时候，靠它自动退回直连 */
let failures = 0;

/**
 * 两条路各自要多久（毫秒，指数平均）。
 *
 * 不写死「直连最快」：这台机器直连 Gate 要两三秒，走本地代理只要三四百毫秒；
 * 换成别的网络又可能反过来。所以谁快走谁，一边用一边继续量，慢了就自己换边。
 */
const routeMs: { direct: number; proxy: number } = { direct: 0, proxy: 0 };
/** 一次尝试最多等多久。某条路被黑洞住的时候，不能让整个请求跟着卡死 */
const ATTEMPT_MS = 8000;

function noteMs(route: 'direct' | 'proxy', ms: number): void {
  const old = routeMs[route];
  routeMs[route] = old > 0 ? Math.round(old * 0.6 + ms * 0.4) : Math.round(ms);
}

/** 失败的那条先按「很慢」记：下一次自然换另一条，成功时会把真实耗时再拉回来 */
function noteFailure(route: 'direct' | 'proxy'): void {
  routeMs[route] = routeMs[route] > 0 ? Math.max(routeMs[route], ATTEMPT_MS) : ATTEMPT_MS;
}

function pickRoute(preferDirect: boolean): 'direct' | 'proxy' {
  if (!state.on) return 'direct';
  const d = routeMs.direct;
  const p = routeMs.proxy;
  if (d > 0 && p > 0) return d <= p ? 'direct' : 'proxy';
  if (d > 0) return 'direct';
  if (p > 0) return 'proxy';
  // 都还没量过：配了代理就先走代理（一般就是因为直连不通或者太慢），量出来会自己纠正
  return preferDirect ? 'direct' : 'proxy';
}

function dispatcherFor(route: 'direct' | 'proxy'): Dispatcher {
  return route === 'proxy' && state.on ? current : direct;
}

/** 走一条路发一次，顺手记下这次花了多久 */
async function attempt(
  route: 'direct' | 'proxy',
  url: string,
  init: FetchInit,
  limit: number = ATTEMPT_MS,
): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
  const timeout = AbortSignal.timeout(limit);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const started = Date.now();
  const res = await undiciFetch(url, { ...init, signal, dispatcher: dispatcherFor(route) });
  noteMs(route, Date.now() - started);
  return res;
}

/**
 * 代理配着不代表能用：代理进程可能已经退出，注册表还没清。探一次真的能不能出网。
 * 探的时候顺手记下这条路多快 —— 起服务的时候两条路都量一次，第一次刷行情就能走对。
 */
async function probe(agent: Dispatcher, route: 'direct' | 'proxy'): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  const started = Date.now();
  try {
    const res = await undiciFetch(`${restBaseUrl()}/api/v4/futures/usdt/contracts/BTC_USDT`, {
      dispatcher: agent,
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    // 响应体读掉再放：没消费的 body 会把那条连接一直占着
    await res.text().catch(() => '');
    if (res.ok) noteMs(route, Date.now() - started);
    return res.ok;
  } catch {
    noteFailure(route);
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
    // 代理关了就别攥着那个连接池
    dropProxyAgent();
    state = { on: false, url: '', source: 'direct', at: Date.now() };
    return state;
  }

  // 代理地址不让它连自己，避免把本地代理进程搅进循环；地址没变就复用同一个 agent
  const agent = agentForProxy(found.url);
  // 两条路各探一次：谁快就用谁。这是一分钟一次的小请求，换来后面每次刷行情都走对路。
  // 直连那次不等它 —— 它可能要好几秒，等它只会把第一个页面也拖住；量完自己记进 routeMs。
  const directProbe = probe(direct, 'direct').catch(() => false);
  const ok = await probe(agent, 'proxy');
  void directProbe;
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

/** 两条路各自的耗时，单位毫秒；0 表示还没量到 */
export function routeStats(): { direct: number; proxy: number } {
  return { ...routeMs };
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
  opts: { private?: boolean; direct?: boolean; preferDirect?: boolean; attemptMs?: number } = {},
): Promise<ReturnType<typeof undiciFetch>> {
  // 一次尝试最多等多久。整张合约表、全量行情这种大包在慢网下要几十秒，
  // 用默认的 8 秒必然超时 —— 调用方按需要放宽。不放宽的话，「拉不到」和「本来就没有」
  // 在页面上长得一样：币种列表空着，也没人说一句为什么。
  const limit = opts.attemptMs && opts.attemptMs > 0 ? opts.attemptMs : ATTEMPT_MS;
  const blocked = opts.private === true && blockedAt > 0 && Date.now() - blockedAt < BLOCK_TTL_MS;
  if (opts.direct === true || !state.on || blocked) return attempt('direct', url, init, limit);

  const method = (init.method ?? 'GET').toUpperCase();
  /** 下单、撤单这类不能重发：换个路重试一遍可能变成两单，所以只对查询类这么做 */
  const canRetry = method === 'GET';
  const first = pickRoute(opts.preferDirect === true);

  try {
    const res = await attempt(first, url, init, limit);
    failures = 0;
    // 403 是「这一单没被受理」，改直连重发不会重复成交
    if (res.status === 403 && dispatcherFor(first) !== direct) {
      const text = await res.clone().text().catch(() => '');
      if (/not in whitelist/i.test(text)) {
        blockedAt = Date.now();
        noteFailure('proxy');
        state = { ...state, blockedAt, at: Date.now() };
        return attempt('direct', url, init, limit);
      }
    }
    return res;
  } catch (err) {
    noteFailure(first);
    if (init.signal?.aborted) throw err;
    failures += 1;
    if (failures >= 2 && dispatcherFor(first) !== direct) {
      // 连着失败：整体退回直连，30 秒后再探。别让接下来每个请求都先撞一次墙
      current = direct;
      state = { ...state, on: false, error: err instanceof Error ? err.message : String(err), at: Date.now() };
      setTimeout(() => { void refreshProxy(true); }, 30_000).unref();
    }
    const other: 'direct' | 'proxy' = first === 'direct' ? 'proxy' : 'direct';
    if (!canRetry || (other === 'proxy' && !state.on)) throw err;
    const res = await attempt(other, url, init, limit);
    failures = 0;
    return res;
  }
}
