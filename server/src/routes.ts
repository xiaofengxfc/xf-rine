import { Router, type Request, type Response } from 'express';
import {
  config, keyHint, keyHintFor, writeEnv, restBaseUrl, envLabel, keySlot, aiKeyHint, aiEndpoint,
  remoteAccess, ENV_PATH, type GateEnv,
} from './config.js';
import { gatePublic, gatePublicTrade, gatePrivate, GateError, requireKeys } from './gate/rest.js';
import { netFetch, proxyState, refreshProxy } from './net.js';
import type { Bar } from './bar.js';
import type { Direction, Zone } from './sr/types.js';
import * as sr from './sr/client.js';
import { SidecarError } from './sr/client.js';
import { mountResearch } from './sr/research.js';
import { mountQuant } from './quant/routes.js';
import { getStrategy as getSavedStrategy, listStrategies as listSavedStrategies } from './quant/library.js';
import { checkRunnable, bindingOf } from './aiStrategy.js';
import { newsDigest } from './news.js';
import { analyze, testConnection, listModels, chatJson, AiError, type AiSnapshot } from './ai.js';
import { AiRunner, type ExecRequest, type RunnerDeps } from './aiRunner.js';
import { AI_STRATEGY_PATH, loadStrategy, saveStrategy, sanitizeStrategy, type StrategyConfig } from './aiStrategy.js';
import { sendFeedback, feedbackTarget, FeedbackError } from './feedback.js';
import { DataError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { HOME_DIR } from './config.js';


export const router = Router();

const INTERVALS = new Set(['10s', '1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '7d']);

/** 每个周期一根 K 线占多少秒。判断缓存里那一段连不连得上要靠它 */
const STEP_SEC: Record<string, number> = {
  '10s': 10, '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '4h': 14400, '8h': 28800, '1d': 86400, '7d': 604800,
};

/**
 * 本地数据目录里那套周期代号（D1 / H1 / M15…）。
 *
 * 本地模式下前端把文件名里的代号原样带过来，只查 STEP_SEC 会退到 60 秒 ——
 * 日线的「连续一段」判定、尾部缓存有效期全按一分钟算，补历史和缓存都不对。
 */
const LOCAL_STEP_SEC: Record<string, number> = {
  M1: 60, M3: 180, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H2: 7200, H4: 14400, H6: 21600, H8: 28800, H12: 43200,
  D1: 86400, W1: 604800,
};

/** 一根 K 线占多少秒。交易所那套和本地那套写法都认 */
function stepSeconds(interval: string): number {
  return STEP_SEC[interval] ?? STEP_SEC[interval.toLowerCase()] ?? LOCAL_STEP_SEC[interval.toUpperCase()] ?? 60;
}

/**
 * K 线时间轴。
 *
 * 以前是按「合约:周期:根数:before」缓存整页，4 秒就过期 —— 往回拖每拖一屏
 * 都要重新问一次交易所（一次一到三秒），拖回来的时候也是。
 *
 * 历史 K 线其实不会变，所以改成按 (合约, 周期) 攒成一条时间轴：
 * 已经拉过的区间谁来要都直接切一段给他，只有要的窗口确实在时间轴外面才补。
 * 最新那一页还在长，单独用 NEWEST_TTL 管过期。
 */
interface BarSeries {
  /** 按时间升序，中间不断档（断档的页不会并进来） */
  bars: Bar[];
  /** 最新一页是什么时候拉的 */
  newestAt: number;
  /** 最后一次被用到的时间，用来淘汰最久没人看的 */
  usedAt: number;
  /** 撞到过交易所的保留边界：再往前它不给了 */
  exhausted: boolean;
  /** 撞到边界的时刻。过了 EXHAUSTED_TTL 允许再探一次，误判不会永久生效 */
  exhaustedAt: number;
  /** 连续失败次数。到 FAIL_LIMIT 就歇一会儿，别一直往交易所打 */
  fails: number;
  /** 这个时刻之前不再往上要 */
  coolUntil: number;
}
const seriesCache = new Map<string, BarSeries>();
/**
 * 交易所每个周期只给约一万根。这里留两倍：裁头时不会把刚拉到的历史一起丢掉，
 * 前端要的区间也就不会因为缓存被裁而回空页。
 */
const SERIES_MAX_BARS = 20_000;
const SERIES_KEEP = 8;
const NEWEST_TTL = 4000;
/** exhausted 的存活时间。误判最多让某个周期十分钟不补历史，之后自动重探 */
const EXHAUSTED_TTL = 10 * 60_000;
const FAIL_LIMIT = 3;
const FAIL_COOL_MS = 10_000;

function seriesFor(key: string): BarSeries {
  const hit = seriesCache.get(key);
  if (hit) { hit.usedAt = Date.now(); return hit; }
  const fresh: BarSeries = {
    bars: [], newestAt: 0, usedAt: Date.now(),
    exhausted: false, exhaustedAt: 0, fails: 0, coolUntil: 0,
  };
  if (seriesCache.size >= SERIES_KEEP) {
    let victim = '';
    let oldest = Infinity;
    for (const [k, v] of seriesCache) {
      if (v.usedAt < oldest) { oldest = v.usedAt; victim = k; }
    }
    if (victim) seriesCache.delete(victim);
  }
  seriesCache.set(key, fresh);
  return fresh;
}

/** 到头了没有。过期之后算没过期，下一次请求会再去探一次 */
function isExhausted(s: BarSeries): boolean {
  return s.exhausted && Date.now() - s.exhaustedAt < EXHAUSTED_TTL;
}

function markExhausted(s: BarSeries): void {
  s.exhausted = true;
  s.exhaustedAt = Date.now();
}

/**
 * 交易所报「要的比它留的还老」。别的错误不能当成到头：
 * 一次超时或限流被当成到头，这个周期就再也不补历史了。
 */
function isRetentionError(e: GateError): boolean {
  return /too long ago|INVALID_PARAM_VALUE|out of range/i.test(`${e.label} ${e.detail}`);
}

/** 缺口日志按 (合约,周期) 一分钟最多一条：图上看着像「残了一块」，日志里得能对上 */
const gapNoted = new Map<string, number>();
function noteGap(key: string): void {
  const now = Date.now();
  if (now - (gapNoted.get(key) ?? 0) < 60_000) return;
  gapNoted.set(key, now);
  console.warn(`[candles] ${key} 取到短页：时间轴上这一段有缺口`);
}

/** 第一个 time >= t 的位置（时间轴有序） */
function lowerBoundTime(bars: Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 从 end 往前数，取一段连续的 K 线（间隔正好 step），最多 limit 根。
 * 遇到断档就停：中间真缺了一段的话，宁可少给、让调用方去补，也不要给一条假的时间轴。
 */
function contiguousRun(bars: Bar[], end: number, limit: number, step: number): Bar[] {
  if (end <= 0) return [];
  let start = end - 1;
  while (start > 0 && bars[start - 1]!.time === bars[start]!.time - step) start -= 1;
  return bars.slice(Math.max(start, end - limit), end);
}

/** 把一段 K 线并进时间轴：按时间对齐，同一时间以新的为准（最后一根还在走） */
function mergeInto(s: BarSeries, add: Bar[]): void {
  if (add.length === 0) return;
  const a = s.bars;
  const out: Bar[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < add.length) {
    const x = a[i]!;
    const y = add[j]!;
    if (x.time < y.time) { out.push(x); i += 1; }
    else if (x.time > y.time) { out.push(y); j += 1; }
    else { out.push(y); i += 1; j += 1; }
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < add.length) out.push(add[j++]!);
  s.bars = out.length > SERIES_MAX_BARS ? out.slice(out.length - SERIES_MAX_BARS) : out;
}

/** 会带出密钥或者会动真钱的接口，只认本机回环地址 */
function requireLocal(req: Request, what: string): void {
  const ip = req.socket.remoteAddress ?? '';
  if (!/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/.test(ip)) {
    throw new GateError(403, 'LOCAL_ONLY', `${what}只允许本机访问`);
  }
}

/** 两个环境各自的密钥状态，设置页要一次看到两套 */
function keysByEnv(): Record<GateEnv, { configured: boolean; hint: string }> {
  return { testnet: keyHintFor('testnet'), live: keyHintFor('live') };
}

// ---------- 下单前的二次确认令牌 ----------
/**
 * 已解锁的令牌。解锁没有有效期：一直有效到主动锁定、切换环境、或者关掉下单开关。
 *
 * 以前是 10 分钟到期。盯盘的人看到信号那一刻正好过期，就得先解锁再下单，
 * 中间价格已经走了 —— 解锁要挡的是「误触」，不是「用久了」。
 */
const armTokens = new Set<string>();

/**
 * 这个请求带的令牌还有效吗。
 *
 * 页面靠它校对自己那句「交易已解锁」：令牌在服务端内存里，服务重启、
 * 或者在另一台设备上锁定过之后就没了，页面自己看不出来。
 */
function armValid(req: Request): boolean {
  return armTokens.has(String(req.header('x-arm-token') ?? ''));
}

function requireArm(req: Request): void {
  if (!armValid(req)) {
    throw new GateError(403, 'NOT_ARMED', '未解锁交易，请先在页面右上角点「解锁交易」');
  }
}

function notionalOf(sizeContracts: number, price: number, multiplier: number): number {
  return Math.abs(sizeContracts) * multiplier * price;
}

function fail(res: Response, err: unknown): void {
  if (err instanceof AiError) {
    res.status(err.status === 200 ? 400 : err.status).json({ error: err.label, detail: err.detail });
    return;
  }
  if (err instanceof GateError) {
    res.status(err.status === 200 ? 400 : err.status).json({ error: err.label, detail: err.detail, status: err.status });
    return;
  }
  if (err instanceof DataError) {
    res.status(err.status === 200 ? 400 : err.status).json({ error: err.label, detail: err.message, status: err.status });
    return;
  }
  /**
   * 引擎没起来 / 算挂了。
   *
   * 这种情况不是「请求写错了」，是「这一块能力现在没有」：前端按 ENGINE_UNAVAILABLE
   * 显示「关键位引擎未就绪」并给出原因，而不是弹一条红色的 500。
   */
  if (err instanceof SidecarError) {
    const status = err.unavailable ? 503 : 500;
    res.status(status).json({ error: err.code, detail: err.message, engine: true });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: 'INTERNAL', detail: msg });
}

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => fail(res, translate(e))); };

/**
 * 交易所拒单时的几句英文，对用户没有任何意义。在 fail 之前翻译成人话：
 *   READ_ONLY                 这把密钥只开了读权限，下单/设杠杆一律被拒
 *   CONTRACT_NOT_FOUND        测试网只上架了几十个合约，主网有一千多个
 *   MARKET_PRICE_TOO_DEVIATED 盘口另一边没有能成交的价，市价单被滑点保护拒了
 */
export function translate(e: unknown): unknown {
  if (!(e instanceof GateError)) return e;

  /**
   * 密钥没有「合约交易」写权限。
   *
   * 这种钥匙读行情、读账户都是好的，页面上一切正常，只有到点下单才被交易所拒 ——
   * 所以必须在这里说清是权限没勾对、去哪儿改，而不是把
   *   Request API key does not have futures write permission
   * 原样甩给用户。以前那两句英文还会连着弹两次（先设杠杆、再下单）。
   *
   * 认两处：Gate 的 label（READ_ONLY），和它的英文原文 —— 没有 label 的接口
   * 会把 message 直接顶到 label 上（见 gate/rest.ts）。
   */
  if (e.label === 'READ_ONLY' || /does not have futures write permission/i.test(`${e.label} ${e.detail}`)) {
    return new GateError(
      403,
      'KEY_NO_WRITE',
      '这把 API 密钥没有「合约交易」写权限，设杠杆、下单、平仓都会被交易所拒掉'
      + '（读行情、看账户是好的，所以页面上看不出问题）。'
      + '到 Gate 的「API 管理」里把这把钥匙的权限改成「合约交易 · 读写」并保存，密钥本身不用换，改完重下一次就行。'
      + `现在用的是${envLabel()}那套密钥，改的也是它。`,
    );
  }

  if (e.label === 'MARKET_PRICE_TOO_DEVIATED' || e.label === 'PRICE_TOO_DEVIATED') {
    // 这句最常出现在平仓上：盘口是空的，市价平不掉，用户会以为程序坏了
    return new GateError(
      400,
      'PRICE_TOO_DEVIATED',
      '交易所拒了这一单：盘口另一边没有能成交的价（挂单太薄，或者价格正在剧烈跳动）。'
      + '仓位没有任何问题，过几秒重试就行；一直不行就到交易所网页上手动平。'
      + (config.env === 'testnet' ? '模拟盘的盘口经常是空的，这类拒绝多半不是你的操作有问题。' : ''),
    );
  }

  if (e.label !== 'CONTRACT_NOT_FOUND' || config.env !== 'testnet') return e;
  return new GateError(
    400,
    'NOT_IN_TESTNET',
    '这个合约在模拟盘没有上市。测试网只上架了几十个合约（主网有一千多个），'
    + '换成主流币，或者到设置页切到实盘再下单。',
  );
}

// ---------- 合约与行情 ----------

interface GateContract {
  name: string; quanto_multiplier: string; order_size_min: number; order_size_max: number;
  order_price_round: string; mark_price_round: string; leverage_min: string; leverage_max: string;
  last_price: string; mark_price: string; funding_rate: string; funding_rate_indicative: string;
  funding_interval: number; in_delisting: boolean; status: string; position_size: number;
  taker_fee_rate: string; maker_fee_rate: string; order_price_deviate: string;
}

/**
 * 合约元数据（最小变动、杠杆上限、手续费）不常变，缓存一分钟。
 * 行情接口要按合约取最小变动价，每 12 秒拉一次全表太浪费。
 */
let contractCache: { at: number; list: GateContract[] } | null = null;
let contractBusy: Promise<void> | null = null;
let contractRetry: NodeJS.Timeout | null = null;

/** 整张合约表一个多 MB，国内直连要几秒到十几秒 —— 所以拉到就一直留着，过一小时才重拉 */
function refreshContracts(): Promise<void> {
  if (contractBusy) return contractBusy;
  contractBusy = (async () => {
    // 这张表 1.4 MB、直连实测三十秒上下。超时给足，失败要说出来 ——
    // 以前这里静默吞掉，结果整个进程活着期间都是空表：最小变动价拿不到，
    // 「按比例算张数」也在猜，界面上却一个字都不提。
    const list = await gatePublic<GateContract[]>('/futures/usdt/contracts', {}, 90_000, 90_000);
    contractCache = { at: Date.now(), list };
    console.log(`[contracts] 合约表就绪：${list.length} 个`);
  })()
    .catch((e) => {
      const why = e instanceof Error ? e.message : String(e);
      console.error('[contracts] 拉合约表失败：' + why.slice(0, 200));
      // 失败了要自己再试，否则这次启动就一直空着
      if (!contractRetry) {
        contractRetry = setTimeout(() => { contractRetry = null; void refreshContracts(); }, 5 * 60_000);
        contractRetry.unref?.();
      }
    })
    .finally(() => { contractBusy = null; });
  return contractBusy;
}

/** 单独取一次，避免 TS 把上面那个分支的 null 收窄带进来 */
const cachedContracts = (): GateContract[] => contractCache?.list ?? [];


/** 不等：有就先用着，没有就返回空，顺手在后台拉。行情接口不该被这张大表拖住 */
function contractsNow(): GateContract[] {
  if (!contractCache || Date.now() - contractCache.at > 60 * 60_000) void refreshContracts();
  return contractCache?.list ?? [];
}

// 开机就拉：这张表三十秒才回来，等第一个请求来催就太晚了。
void refreshContracts();

/**
 * 只取单个合约的参数，不拉整张表。
 * 那张表上千个合约、一个多 MB，从国内直连经常十几秒才回，超时还拿不到缓存 ——
 * 一次下单、一次刷持仓都跟着卡十几秒。
 */
const tradeContractCache = new Map<string, { at: number; c: GateContract }>();
async function tradeContract(name: string): Promise<GateContract> {
  const hit = tradeContractCache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.c;
  const c = await gatePublicTrade<GateContract>(`/futures/usdt/contracts/${encodeURIComponent(name)}`);
  tradeContractCache.set(name, { at: Date.now(), c });
  return c;
}


router.get('/contracts/:name', wrap(async (req, res) => {
  const name = String(req.params.name);
  const [c, tradable] = await Promise.all([
    gatePublic<GateContract>(`/futures/usdt/contracts/${encodeURIComponent(name)}`),
    tradableNames(),
  ]);
  res.json({
    // 当前环境（尤其模拟盘）能不能交易它
    tradable: tradable === null ? true : tradable.has(c.name),
    name: c.name,
    multiplier: Number(c.quanto_multiplier),
    sizeMin: c.order_size_min,
    sizeMax: c.order_size_max,
    priceRound: Number(c.order_price_round),
    leverageMin: Number(c.leverage_min),
    leverageMax: Number(c.leverage_max),
    price: Number(c.last_price),
    markPrice: Number(c.mark_price),
    fundingRate: Number(c.funding_rate),
    fundingRateIndicative: Number(c.funding_rate_indicative),
    fundingInterval: c.funding_interval,
    takerFee: Number(c.taker_fee_rate),
    makerFee: Number(c.maker_fee_rate),
    orderPriceDeviate: Number(c.order_price_deviate),
    status: c.status,
  });
}));

interface GateCandle { t: number; o: string; h: string; l: string; c: string; v: number; sum: string }

/**
 * 去交易所要一页。
 *
 * Gate 的 to 是闭区间：给 to=X、limit=1000，拿到的是 [X-999根, X]，含 X 那根。
 * 我们要的是「X 之前的 1000 根」，所以 to 得往前挪一根 —— 否则那 1000 根里有一根
 * 是重复的 X，丢掉之后只剩 999 根，接缝处就少一根，图上看着是断的。
 */
async function fetchPage(contract: string, interval: string, limit: number, step: number, before?: number): Promise<Bar[]> {
  const params: Record<string, string | number> = { contract, interval, limit };
  if (before) params.to = before - step;
  const raw = await gatePublic<GateCandle[]>('/futures/usdt/candlesticks', params);
  return raw
    .map((c) => ({
      time: Number(c.t),
      open: Number(c.o),
      high: Number(c.h),
      low: Number(c.l),
      close: Number(c.c),
      volume: Number(c.v),
    }))
    .filter((b) => !before || b.time < before)
    .sort((x, y) => x.time - y.time);
}

/**
 * 取一段 K 线。
 *
 * before 有值：要早于它的 limit 根。先看时间轴里有没有 —— 有就切一段，一次上游都不打；
 * 不够才补一页，补完再切（补的那页和原来的接上了，所以切出来的必然连续）。
 * before 没值：要最新的 limit 根，tailTtl 之内直接用时间轴尾巴。
 *
 * tailTtl 是给「档位」那种慢半拍也无所谓的调用方的：它只看得上收盘的 K 线，
 * 一根之内拿到的都算新，没必要每 45 秒就为它去交易所跑一趟。
 */
/** 同一个位置正在拉的时候别拉第二遍：预热和用户拖动常常撞在同一页上 */
const inflight = new Map<string, Promise<Bar[]>>();

/** 正在预热的时间轴，避免同一个位置被同时拉两次 */
const warming = new Set<string>();

/**
 * 提前把下一段历史拉进时间轴。
 *
 * 用户往回拖是一页一页来的：这一页刚看到手，下一页马上就会被要。与其让人在边缘等
 * 一秒多，不如这一页给出去之后就去把下一页取回来 —— 等真的拖动时命中的是缓存，几毫秒。
 * 不 await、失败不吵：这纯粹是为了下一步更顺，慢一点、拉不到都不影响当前这一页。
 */
function warmOlder(contract: string, interval: string, limit: number, before: number): void {
  if (!before) return;
  const key = `${contract}:${interval}:${before}`;
  if (warming.has(key)) return;
  warming.add(key);
  void loadCandles(contract, interval, limit, false, before)
    .catch(() => {})
    .finally(() => warming.delete(key));
}

/**
 * 上游同时最多发几条 K 线请求。
 *
 * 预热和用户自己的请求一叠，再加上频繁拖动，交易所和本地代理会一起排队，
 * 单条就能拖到八秒以上、直接被判超时。这里只放两条进去，其余排队等。
 */
const FETCH_SLOTS = 2;
let fetchActive = 0;
const fetchWaiting: (() => void)[] = [];

async function withFetchSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (fetchActive >= FETCH_SLOTS) await new Promise<void>((resolve) => fetchWaiting.push(resolve));
  fetchActive += 1;
  try {
    return await fn();
  } finally {
    fetchActive -= 1;
    fetchWaiting.shift()?.();
  }
}

/** Gate 的限流。GET 是幂等的，等一会儿再要一次就行，别把 429 甩给前端 */
function isRateLimited(e: unknown): boolean {
  return e instanceof GateError && e.status === 429;
}

/** 被限流时退避几次。交易所这个窗口过去就好了，用户不该看到「K 线没拉到」 */
const RATE_RETRY_MS = [250, 500];

/** 同一页在飞就复用那一次请求，回来各自并进时间轴（合并是幂等的） */
function fetchOnce(contract: string, interval: string, limit: number, step: number, before?: number): Promise<Bar[]> {
  const key = `${contract}:${interval}:${before ?? 0}`;
  const had = inflight.get(key);
  if (had) return had;
  const p = withFetchSlot(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchPage(contract, interval, limit, step, before);
      } catch (e) {
        if (!isRateLimited(e) || attempt >= RATE_RETRY_MS.length) throw e;
        await new Promise((resolve) => { setTimeout(resolve, RATE_RETRY_MS[attempt]!); });
      }
    }
  });
  inflight.set(key, p);
  void p.finally(() => inflight.delete(key)).catch(() => {});
  return p;
}

interface CandlePage {
  bars: Bar[];
  /** 交易所那边已经没有更早的数据了（它只保留最近一万个点） */
  exhausted: boolean;
  /**
   * 要了满满一页却没给满：时间轴上这段有洞，或者上游少给。
   *
   * 不设这个标记的话，前端拿到短页只会觉得「就这么多」，缺口被静默压掉；
   * 有了它，体检脚本和日志能看出来是数据断了，而不是真的到头。
   */
  gap?: boolean;
}

async function loadCandles(
  contract: string,
  interval: string,
  limit: number,
  fresh = false,
  /** 只要早于这个时间的 K 线（秒）。不传就是取最新的 limit 根。 */
  before?: number,
  tailTtl = NEWEST_TTL,
): Promise<CandlePage> {
  const series = seriesFor(`${contract}:${interval}`);
  const step = stepSeconds(interval);

  /** 时间轴里「早于 before 的连续一段」。裁头之后这一段可能是空的 */
  const slice = () => contiguousRun(series.bars, lowerBoundTime(series.bars, before!), limit, step);

  /**
   * 这一页是不是已经接到手上最老那一根了。
   *
   * exhausted 的含义是「返回的这批 K 线后面没有了」。时间轴早就攒满了、
   * 又标过到头的时候，缓存里还压着几千根没给出去，这时照样是 false ——
   * 不然前端拿到满满一页却看到 exhausted，会当场停手，剩下的永远拉不出来。
   */
  const endedAt = (page: Bar[]): boolean => {
    if (!isExhausted(series)) return false;
    const oldest = series.bars[0]?.time;
    return page.length === 0 || oldest === undefined || page[0]!.time <= oldest;
  };

  if (before) {
    /**
     * 要的是「满满一页」。交易所偶尔少给几根就接着往下补 —— 短页回给前端，
     * 前端会当成到头了，从此不再加载，那才是真正的看着缺数据。
     */
    const cached = slice();
    if (!fresh && cached.length >= limit) return { bars: cached, exhausted: endedAt(cached) };

    let target = before;
    /** 最后一次真拉回来的那一页。缓存裁头时用它兜底，别把刚拿到的历史丢掉 */
    let lastPage: Bar[] = [];

    /**
     * 上游偶尔少给几根、或者时间轴上这段本来就有洞，一页补不满。
     * 以前最多试 4 次就收手，短页直接甩给前端 —— 前端拿到不满一页就当到头了，
     * 那一段历史从此再也拉不出来。这里多试几轮：只要还在往更早的方向走就接着补。
     */
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (isExhausted(series)) break;
      if (series.coolUntil > Date.now()) break;
      /** 手上最老那一根。空时间轴是 Infinity，此时任何失败都不算到头 */
      const oldest = series.bars.length > 0 ? series.bars[0]!.time : Infinity;
      /**
       * 只有贴着已知最老那根还要不到，才算交易所真到头。
       * 要的远比手上最老的还老（比如要 2017 年），是调用方问了一个离谱的位置 ——
       * 拿它把整条时间轴标成到头，其余几千根就再也拉不出来了。
       */
      const atFrontier = target >= oldest - step;
      let page: Bar[];
      try {
        page = await fetchOnce(contract, interval, limit, step, target);
        series.fails = 0;
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        series.fails += 1;
        if (series.fails >= FAIL_LIMIT) {
          series.coolUntil = Date.now() + FAIL_COOL_MS;
          series.fails = 0;
        }
        if (isRetentionError(e) && atFrontier) markExhausted(series);
        break;
      }
      // Gate 用空数组表示「再往前没有了」。那不是错，是真的到头
      if (page.length === 0) {
        if (atFrontier) markExhausted(series);
        break;
      }
      mergeInto(series, page);
      lastPage = page;
      const got = slice();
      if (!fresh && got.length >= limit) return { bars: got, exhausted: endedAt(got) };
      const head = series.bars.length > 0 ? series.bars[0]!.time : target;
      // 没有往更早的方向走，再要也是同一页
      if (head >= target) break;
      target = head;
    }

    const fromSeries = slice();
    /**
     * 缓存到上限就从头部裁。裁掉的正好是这次要的那一段时，fromSeries 会是空的 ——
     * 直接回空页，前端会静默停在这里。用刚拉回来的这一页兜住。
     */
    const fromPage = contiguousRun(lastPage, lowerBoundTime(lastPage, before), limit, step);
    const bars = fromPage.length > fromSeries.length ? fromPage : fromSeries;
    const ended = endedAt(bars);
    // 要了一整页却没凑满、又不是到头：这段中间有洞，标出来，别再假装它是连续的
    const gap = bars.length < limit && !ended;
    if (gap) noteGap(`${contract}:${interval}`);
    return { bars, exhausted: ended, gap };
  }

  const tailFresh = series.newestAt > 0 && Date.now() - series.newestAt < tailTtl;
  if (!fresh && tailFresh && series.bars.length >= limit) {
    const bars = series.bars.slice(series.bars.length - limit);
    return { bars, exhausted: endedAt(bars) };
  }
  mergeInto(series, await fetchOnce(contract, interval, limit, step));
  series.newestAt = Date.now();
  const bars = series.bars.slice(Math.max(0, series.bars.length - limit));
  return { bars, exhausted: endedAt(bars) };
}

/**
 * 读一个带上下限的数字参数。
 *
 * 不能直接 Math.min/max：Number('abc') 是 NaN，而 Math.min/max 会把 NaN 原样传出去。
 * NaN 当 limit 用，下游的 slice 就退化成「切全部」；打给交易所还会换来一个
 * INVALID_PARAM_VALUE 的 400 —— 一句「参数不对」的报错，看不出是自己传错了。
 * 认不出数字就当没传，用默认值。
 */
function qnum(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

router.get('/candles', wrap(async (req, res) => {
  const contract = String(req.query.contract ?? 'BTC_USDT');
  const interval = INTERVALS.has(String(req.query.interval)) ? String(req.query.interval) : '1m';
  const limit = Math.round(qnum(req.query.limit, 500, 50, 1000));
  const beforeRaw = Number(req.query.before);
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.floor(beforeRaw) : undefined;
  const page = await loadCandles(contract, interval, limit, false, before);
  // 这一页给出去之后，顺手把再往前的一页取回来：下一步多半就是往那边拖
  if (page.bars.length > 0 && !page.exhausted) warmOlder(contract, interval, limit, page.bars[0]!.time);
  // exhausted 是「交易所真没了」，前端只认它；hasMore 留给老前端兜底
  res.json({
    contract,
    interval,
    bars: page.bars,
    hasMore: page.bars.length >= limit,
    exhausted: page.exhausted,
    // 这段历史中间有洞（上游少给）。前端的自愈和体检脚本按它判断，不影响正常画图
    gap: page.gap === true,
  });
}));

// ---------- 档位 ----------

/**
 * 把关键位的距离改挂到「现价」上。
 *
 * 引擎只看得见已经收盘的 K 线，它嘴里的 last 是上一根收盘价；界面上要的是
 * 「离现在这个价格有多远」，所以按最新成交价重算距离。角色也跟着重算：
 * 现价穿过一条位之后，原来在头顶的阻力就变成脚下的支撑。
 */
function withLiveZones(zones: Zone[], live: number, atrValue: number): Zone[] {
  if (!(live > 0)) return zones;
  const a = atrValue > 0 ? atrValue : 0;
  return zones.map((z) => {
    const role: Zone['zone_type'] = z.high < live ? 'support'
      : z.low > live ? 'resistance'
        : z.center <= live ? 'support' : 'resistance';
    return {
      ...z,
      distance_pct: Number((((z.center - live) / live) * 100).toFixed(4)),
      distance_atr: a > 0 ? Number(((z.center - live) / a).toFixed(4)) : z.distance_atr,
      zone_type: role,
      zone_label: role === 'support' ? '支撑带' : '压力带',
    };
  });
}

/** 某一侧离现价最近的那个位 */
function nearestOf(zones: Zone[], role: 'support' | 'resistance'): Zone | null {
  const pool = zones.filter((z) => z.zone_type === role);
  if (pool.length === 0) return null;
  return pool.reduce((x, y) => (Math.abs(y.distance_atr) < Math.abs(x.distance_atr) ? y : x));
}

/**
 * 交易所周期名 -> 引擎认的周期代号。
 *
 * 引擎那边的多周期共振按 D1/H4/H1 这套名字认，交易所用 1h/4h/1d。
 * 对不上就等于「邻居周期一个都没找到」，共振永远是 1。
 */
const GATE_TF_TO_STD: Record<string, string> = {
  '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30',
  '1h': 'H1', '4h': 'H4', '8h': 'H8', '1d': 'D1', '7d': 'W1',
};

/**
 * 邻居周期的 K 线（共振用）。
 *
 * 共振要拿同一品种的其他周期各算一遍。每根 K 线都去交易所现拉的话，档位每刷一次就是
 * 四五趟往返，太贵；所以这里只在时间轴里已经有这一段时直接用，没有就拉一页并缓存五分钟。
 * 拉不到就当这个周期不存在 —— 共振少算一层，好过让整条档位请求失败。
 */
const MTF_TTL_MS = 5 * 60_000;
const MTF_LADDER = ['15m', '30m', '1h', '4h', '8h', '1d'];
const mtfCache = new Map<string, { at: number; bars: Bar[] }>();

async function mtfFrames(contract: string, interval: string): Promise<{ tf: string; bars: Bar[] }[]> {
  const idx = MTF_LADDER.indexOf(interval);
  if (idx < 0) return [];
  const wanted = [MTF_LADDER[idx + 1], MTF_LADDER[idx + 2], MTF_LADDER[idx - 1]].filter((x): x is string => Boolean(x));
  const out: { tf: string; bars: Bar[] }[] = [];
  for (const iv of wanted) {
    const code = GATE_TF_TO_STD[iv];
    if (!code) continue;
    const key = contract + ':' + iv;
    const hit = mtfCache.get(key);
    if (hit && Date.now() - hit.at < MTF_TTL_MS) { out.push({ tf: code, bars: hit.bars }); continue; }
    try {
      const page = await loadCandles(contract, iv, 600, false, undefined, MTF_TTL_MS);
      mtfCache.set(key, { at: Date.now(), bars: page.bars });
      out.push({ tf: code, bars: page.bars });
    } catch { /* 这个周期拿不到就算了 */ }
  }
  return out;
}

/** 合约的最小变动价。读不到就让引擎按收盘价估 */
function priceTickOf(contract: string): number {
  try {
    const c = contractsNow().find((x) => x.name === contract);
    return c ? Number(c.order_price_round) || 0 : 0;
  } catch { return 0; }
}

/**
 * 档位有两条数据来源：交易所的实时 K 线，或者你本地那个 Parquet 目录。
 *
 * 两条路走的是同一个引擎（Python sidecar 里的上游 V3Fusion），区别只在 K 线从哪来：
 * 本地那条把目录和品种名交给引擎，它自己读文件；交易所那条由这里把 K 线喂进去。
 * 算出来的都是「离现价多远」，只是现价的定义不同：本地数据的最后一根收盘价。
 */
router.get('/levels', wrap(async (req, res) => {
  const source = String(req.query.source ?? 'gate') === 'local' ? 'local' : 'gate';
  const limit = Math.round(qnum(req.query.limit, 500, 120, 5000));
  // 每侧最多几个位：引擎的 n_zones 就是「单侧上限」
  const nZones = Math.round(qnum(req.query.n_zones ?? req.query.maxOut, 3, 1, 8));
  const dirRaw = String(req.query.direction ?? 'both').toLowerCase();
  const dir: Direction = dirRaw === 'long' || dirRaw === 'short' ? dirRaw : 'both';
  const mtf = String(req.query.mtf ?? 'true').toLowerCase() !== 'false';

  if (source === 'local') {
    requireLocal(req, '本地数据');
    const symbol = String(req.query.symbol ?? '');
    const tf = String(req.query.tf ?? 'D1').toUpperCase();
    const r = await sr.analyzeLocal({
      dir: requireDataDir(), symbol, tf, n_zones: nZones, direction: dir, mtf, n_bars: 0,
    });
    const zones = withLiveZones(r.zones, r.current_price, r.engine.atr);
    res.json({
      contract: r.symbol,
      interval: r.tf,
      source: 'local',
      barsUsed: r.data_bars,
      last: r.current_price,
      atr: r.engine.atr,
      zones,
      nearestSupport: nearestOf(zones, 'support'),
      nearestResistance: nearestOf(zones, 'resistance'),
      summary: r.summary,
      engine: r.engine,
      mtf_zones: r.mtf_zones,
    });
    return;
  }

  const contract = String(req.query.contract ?? 'BTC_USDT');
  const interval = INTERVALS.has(String(req.query.interval)) ? String(req.query.interval) : '15m';
  // 档位只看收盘的 K 线，晚一根的时间无所谓：时间轴里那一段够新就用它，别为它跑一趟交易所
  const { bars } = await loadCandles(contract, interval, limit, false, undefined, stepSeconds(interval) * 1000);
  // 丢掉最后一根未走完的 K 线：半根 K 线的影线不该参与判位
  const closed = bars.slice(0, -1);
  const live = bars[bars.length - 1]?.close ?? 0;
  const frames = [
    { tf: GATE_TF_TO_STD[interval] ?? interval.toUpperCase(), bars: closed },
    ...(mtf ? await mtfFrames(contract, interval) : []),
  ];
  const r = await sr.analyzeBars({
    symbol: contract, tf: frames[0]!.tf, frames, n_zones: nZones, direction: dir,
    mtf, tick: priceTickOf(contract),
  });
  const zones = withLiveZones(r.zones, live, r.engine.atr);
  res.json({
    contract,
    interval,
    source: 'gate',
    barsUsed: closed.length,
    last: live || r.current_price,
    atr: r.engine.atr,
    zones,
    nearestSupport: nearestOf(zones, 'support'),
    nearestResistance: nearestOf(zones, 'resistance'),
    summary: r.summary,
    engine: r.engine,
    mtf_zones: r.mtf_zones,
  });
}));


// ---------- 本地数据目录（移植上游的数据层） ----------

/**
 * 记住的数据目录存在哪。
 *
 * 上游是 /api/data_dir 把任意路径写进内存，下次继续用。在桌面端这等于给网页开了
 * 一个「随便读你硬盘」的口子，所以这里加两道锁：写要 requireLocal（本机），
 * 读出来的路径必须在 XFRINE_DATA_DIR_ALLOW 给的根目录下（没配就以第一次选的那个为根）。
 */
const DATA_DIR_FILE = join(HOME_DIR, 'data-dir.json');

function readDataDir(): string {
  try {
    const j = JSON.parse(readFileSync(DATA_DIR_FILE, 'utf8')) as { dir?: string };
    return String(j.dir ?? '');
  } catch { return ''; }
}

function requireDataDir(): string {
  const d = readDataDir();
  if (!d) throw new DataError(400, 'NO_DIR', '还没选本地数据目录，先到设置页选一个');
  return d;
}

/**
 * 记住一个数据目录。
 *
 * 上游把路径直接写进内存，谁都能改。这里两道锁：
 *   1. 写只认本机（requireLocal）—— 选目录等于让程序读你的硬盘
 *   2. 配了 XFRINE_DATA_DIR_ALLOW 时，路径必须落在它给的根目录下
 *
 * 目录本身还能不能读出 K 线由引擎判断，这里只保证「路径存在、在允许范围里」。
 */
function storeDataDir(rawInput: string): string {
  const raw = (rawInput ?? '').trim();
  if (!raw) throw new DataError(400, 'BAD_INPUT', '缺少 dir');
  const abs = resolve(raw);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new DataError(404, 'NO_DIR', '这个目录不存在：' + abs);
  }
  const allow = (process.env.XFRINE_DATA_DIR_ALLOW ?? '').trim();
  if (allow) {
    const roots = allow.split(';').map((x) => resolve(x.trim())).filter(Boolean);
    const inside = roots.some((r) => abs === r || abs.startsWith(r + sep));
    if (!inside) throw new DataError(403, 'OUTSIDE_ROOT', '这个目录不在允许的根目录里：' + roots.join(' / '));
  }
  writeFileSync(DATA_DIR_FILE, JSON.stringify({ dir: abs, at: Date.now() }, null, 2), 'utf8');
  return abs;
}

/**
 * 目录里有哪些品种。
 *
 * 解析交给引擎（Python 那边的 local_data_loader），和真正读文件用的是同一套命名规则 ——
 * 两边各写一份迟早会漂：列表里有、点进去读不到，是最难解释的一类故障。
 */
router.get('/data/dir', wrap(async (_req, res) => {
  // 读目录不加 requireLocal：它只列「目录里有什么」，不动文件。
  // 研究台和日内台现在共用这一份状态 —— 手机端只读不改，两边看到的必须是同一个目录，
  // 否则手机上研究台有数据、切回日内台却是空的。
  const dir = readDataDir();
  if (!dir) { res.json({ dir: '', instruments: [], files: 0, count: 0, exists: false }); return; }
  try {
    const out = await sr.instruments(dir);
    res.json({
      dir: out.data_dir,
      instruments: out.instruments,
      files: (out as { files?: number }).files ?? 0,
      count: out.count,
      tfLabels: out.tf_labels,
      exists: true,
    });
  } catch (e) {
    // 目录在，但引擎没起来 / 读不了：如实说，别让整页崩
    res.json({
      dir, instruments: [], files: 0, count: 0, exists: true,
      warning: (e as Error).message,
    });
  }
}));

router.post('/data/dir', wrap(async (req, res) => {
  // 只认本机、不要 arm 令牌：这一步不碰交易所、不动钱，只是记住「读哪个目录」。
  // 要令牌的话就得先配密钥、先点解锁 —— 而想用本地数据的人往往根本不下单。
  requireLocal(req, '选本地数据目录');
  const dir = storeDataDir(String((req.body as { dir?: string })?.dir ?? ''));
  try {
    const out = await sr.instruments(dir);
    res.json({
      ok: true,
      dir: out.data_dir,
      instruments: out.instruments,
      files: (out as { files?: number }).files ?? 0,
      count: out.count,
      tfLabels: out.tf_labels,
    });
  } catch (e) {
    // 目录已经记住了，但引擎读不出来：照实说，别让用户以为选错了地方
    res.json({ ok: true, dir, instruments: [], files: 0, count: 0, warning: (e as Error).message });
  }
}));

/** 读一个品种某个周期的 K 线。图表和档位都用它，返回的字段和 /candles 对齐 */
router.get('/data/bars', wrap(async (req, res) => {
  requireLocal(req, '本地数据');
  const symbol = String(req.query.symbol ?? '');
  const tf = String(req.query.tf ?? 'D1').toUpperCase();
  const limit = Math.round(qnum(req.query.limit, 500, 30, 20_000));
  const root = requireDataDir();
  const out = await sr.localBars(root, symbol, tf, limit);
  res.json({
    contract: symbol,
    interval: tf,
    source: 'local',
    bars: out.bars,
    total: out.total,
    exhausted: out.returned >= out.total,
    intervalSec: stepSeconds(tf),
  });
}));


// ---------- 新闻雷达 ----------

router.get('/news', wrap(async (req, res) => {
  const contract = String(req.query.contract ?? 'BTC_USDT').toUpperCase();
  const limit = Math.round(qnum(req.query.limit, 8, 1, 20));
  res.json(await newsDigest(contract, limit));
}));

// ---------- AI 分析 ----------

/** 价格留 6 位有效数字就够了，原始浮点白烧 token 还容易被读错 */
const px = (v: number): number => (Number.isFinite(v) ? Number(v.toPrecision(6)) : 0);


async function buildSnapshot(contract: string, interval: string): Promise<AiSnapshot> {
  const { bars } = await loadCandles(contract, interval, 300);
  const closed = bars.slice(0, -1);
  const live = bars[bars.length - 1]?.close ?? 0;
  const tfCode = GATE_TF_TO_STD[interval] ?? interval.toUpperCase();
  // 关键位交给引擎算。AI 看的是同一个引擎的结论，不是另一套近似
  const analysis = await sr.analyzeBars({
    symbol: contract, tf: tfCode, frames: [{ tf: tfCode, bars: closed }],
    n_zones: 3, direction: 'both', mtf: false, tick: priceTickOf(contract),
  });
  const zones = withLiveZones(analysis.zones, live, analysis.engine.atr);
  const news = await newsDigest(contract, 6).catch(() => null);

  let barHigh = live;
  let barLow = live;
  for (const b of closed) {
    if (b.high > barHigh) barHigh = b.high;
    if (b.low < barLow) barLow = b.low;
  }
  const t0 = closed[0]?.time ?? 0;
  const t1 = closed[closed.length - 1]?.time ?? 0;

  // 24 小时涨跌幅直接从手里的 K 线算，不额外请求一次 ticker
  const spanSec = t1 - t0;
  const perBar = closed.length > 1 ? spanSec / (closed.length - 1) : 0;
  const back = perBar > 0 ? Math.min(closed.length - 1, Math.round(86_400 / perBar)) : 0;
  const ref24 = closed[closed.length - 1 - back]?.close ?? live;
  const change24h = ref24 > 0 ? ((live - ref24) / ref24) * 100 : 0;

  return {
    contract,
    interval,
    last: px(live),
    atr: px(analysis.engine.atr),
    rangeHigh: px(barHigh),
    rangeLow: px(barLow),
    barsUsed: closed.length,
    spanHours: Number((t1 > t0 ? (t1 - t0) / 3600 : 0).toFixed(1)),
    barHigh: px(barHigh),
    barLow: px(barLow),
    change24h: Number(change24h.toFixed(2)),
    levels: zones.slice(0, 8).map((z) => ({
      price: px(z.center),
      zone: [px(z.low), px(z.high)],
      // 模型读中文材料，角色也给它中文
      role: z.zone_type === 'support' ? '支撑' : '阻力',
      // 相对强度（触及次数 + 陈旧度），不是概率
      edge: Number(z.edge_score.toFixed(2)),
      // 双概率：触及概率区分度强、守住概率校准好但排序弱，两者都要给
      pTouch: z.p_touch === null ? null : Number((z.p_touch * 100).toFixed(0)),
      pHold: z.p_hold === null ? null : Number((z.p_hold * 100).toFixed(0)),
      nEvents: z.n_events,
      pStall: Number(z.p_stall.toFixed(2)),
      distancePct: Number(z.distance_pct.toFixed(2)),
      bucket: z.bucket,
    })),

    news: {
      stance: news?.stance ?? 'neutral',
      sentiment: news?.sentiment ?? 0,
      headlines: (news?.items ?? []).map((i) => i.title),
    },
  };
}

router.post('/ai/analyze', wrap(async (req, res) => {
  const contract = String(req.body?.contract ?? 'BTC_USDT').toUpperCase();
  const interval = INTERVALS.has(String(req.body?.interval)) ? String(req.body.interval) : '15m';
  const snapshot = await buildSnapshot(contract, interval);
  res.json(await analyze(snapshot));
}));

router.post('/ai/test', wrap(async (req, res) => {
  const ip = req.socket.remoteAddress ?? '';
  if (!/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/.test(ip)) {
    throw new GateError(403, 'LOCAL_ONLY', '测试连接只允许本机访问');
  }
  const body = req.body ?? {};
  const override = {
    baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : config.ai.baseUrl,
    apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : config.ai.apiKey,
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.ai.model,
  };
  res.json(await testConnection(override));
}));

router.get('/ai/snapshot', wrap(async (req, res) => {
  // 给「凭什么这么说」留证据：不调模型，只把喂给模型的材料原样返回
  const contract = String(req.query.contract ?? 'BTC_USDT').toUpperCase();
  const interval = INTERVALS.has(String(req.query.interval)) ? String(req.query.interval) : '15m';
  res.json(await buildSnapshot(contract, interval));
}));

// ---------- 配置与体检 ----------

router.get('/config', (req, res) => {
  // 手机端要填的地址和口令。口令只回本机 —— 本机都打不开页面的话，也没有理由知道它。
  const remote = remoteAccess();
  const local = /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/.test(req.socket.remoteAddress ?? '');
  res.json({
    /**
     * 这个请求是不是从这台电脑上发出来的。
     *
     * 「选本地数据目录」读的是硬盘，服务端只认回环地址。前端以前靠自己看
     * window.location.hostname 猜 —— 可桌面壳（Electron 的 file:// 或 0.0.0.0）
     * 和局域网地址下，那个判断和真实来源根本对不上，按钮要么永远禁用、要么点了才 403。
     * 现在由服务端在这里说了算。
     */
    local,
    env: config.env,
    envLabel: envLabel(),
    restBaseUrl: restBaseUrl(),
    keys: keyHint(),
    keysByEnv: keysByEnv(),
    liveTrading: config.liveTrading,
    // 密钥文件到底存在哪。桌面端不在 server/.env，页面上要能说对地方
    envPath: ENV_PATH,
    remote: { enabled: remote.enabled, urls: remote.urls, token: local ? remote.token : null },
    ai: {
      configured: aiKeyHint().configured,
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      hint: aiKeyHint().hint,
      endpoint: aiEndpoint(),
    },
    armed: false,
    // 反馈寄到哪个信箱，页面要能说清楚 —— 内嵌配置，用户不用自己填
    feedback: feedbackTarget(),
  });
});

/**
 * 写密钥。slotEnv 指定写进哪一格：模拟盘和实盘各存各的，互不覆盖。
 * 这里只管密钥，绝不碰 GATE_ENV —— 填另一套密钥不该顺手把程序切到真钱上。
 */
router.post('/config/keys', wrap(async (req, res) => {
  requireLocal(req, '写密钥');
  const { key, secret, liveTrading, slotEnv } = req.body ?? {};
  const targetEnv: GateEnv = slotEnv === 'testnet' || slotEnv === 'live' ? slotEnv : config.env;
  const slot = keySlot(targetEnv);
  const patch: Record<string, string> = {};
  if (typeof key === 'string' && key.trim()) patch[slot.key] = key.trim();
  if (typeof secret === 'string' && secret.trim()) patch[slot.secret] = secret.trim();
  if (typeof liveTrading === 'boolean') patch.LIVE_TRADING = liveTrading ? 'true' : 'false';
  // AI 三个字段各管各的：传了就写，字符串为空表示清除，不传就不动
  const { aiBaseUrl, aiApiKey, aiModel } = req.body ?? {};
  if (typeof aiBaseUrl === 'string' && aiBaseUrl.trim()) patch.AI_BASE_URL = aiBaseUrl.trim();
  if (typeof aiApiKey === 'string') patch.AI_API_KEY = aiApiKey.trim();
  if (typeof aiModel === 'string' && aiModel.trim()) patch.AI_MODEL = aiModel.trim();
  if (Object.keys(patch).length === 0) throw new GateError(400, 'EMPTY', '没有要写入的字段');
  // 关掉下单开关就是撤销所有已解锁的会话。否则重新打开开关时，
  // 十分钟前解锁的那个令牌还活着，等于开关白关了一次。
  if (typeof liveTrading === 'boolean' && !liveTrading) armTokens.clear();
  writeEnv(patch);
  res.json({
    ok: true,
    env: config.env,
    envLabel: envLabel(),
    keys: keyHint(),
    keysByEnv: keysByEnv(),
    liveTrading: config.liveTrading,
    ai: { configured: aiKeyHint().configured, baseUrl: config.ai.baseUrl, model: config.ai.model, hint: aiKeyHint().hint },
  });
}));

/**
 * 切环境。和写密钥分开，因为这是会改变「钱从哪个账户出」的动作。
 * 一律顺手关掉下单开关：切到实盘意味着换成真钱，绝不能把开关一起带过去。
 */
router.post('/config/env', wrap(async (req, res) => {
  requireLocal(req, '切环境');
  const { env } = req.body ?? {};
  if (env !== 'testnet' && env !== 'live') throw new GateError(400, 'BAD_ENV', 'env 只能是 testnet 或 live');
  // 换环境＝换账户。旧令牌是在另一个账户上解锁的，不能跟着过来：
  // 从模拟盘切到实盘时它要是还有效，就等于绕过了一次「用真钱」的确认。
  armTokens.clear();
  /**
   * AI 交易也一起停掉，理由和上面那句一样：换环境就是换账户。
   * 上一轮「在模拟盘上确认过」不该变成实盘上的授权，所以实盘确认也一起清掉。
   */
  aiRunner.stop();
  saveStrategy({ ...loadStrategy(), enabled: false, liveConfirmed: false });
  writeEnv({ GATE_ENV: env, LIVE_TRADING: 'false' });
  res.json({
    ok: true,
    env: config.env,
    envLabel: envLabel(),
    restBaseUrl: restBaseUrl(),
    keys: keyHint(),
    keysByEnv: keysByEnv(),
    liveTrading: config.liveTrading,
  });
}));

// ---------- 反馈 ----------

/**
 * 最近发信的时刻，按来源地址各记一份。
 *
 * 这张表挡的是误连点（一次点击就是一封真邮件）和顺手压测；
 * 正常用的人一分钟内不会发第二封，撞上这一条也只是等一会儿。
 */
const feedbackSent = new Map<string, number[]>();
const FB_GAP_MS = 15_000;
const FB_HOUR_MAX = 10;

function checkFeedbackRate(ip: string): void {
  const now = Date.now();
  const list = (feedbackSent.get(ip) ?? []).filter((t) => now - t < 60 * 60_000);
  const last = list[list.length - 1] ?? 0;
  if (now - last < FB_GAP_MS) {
    throw new GateError(429, 'TOO_FAST', '刚发过一封，' + Math.ceil((FB_GAP_MS - (now - last)) / 1000) + ' 秒后再发');
  }
  if (list.length >= FB_HOUR_MAX) {
    throw new GateError(429, 'TOO_MANY', '这一小时已经发了 ' + list.length + ' 封，稍后再试');
  }
  feedbackSent.set(ip, [...list, now]);
  // 表别只涨不消：攒到一定量就把过期的整批清掉
  if (feedbackSent.size > 200) {
    for (const [k, v] of feedbackSent) {
      if (v.every((t) => now - t >= 60 * 60_000)) feedbackSent.delete(k);
    }
  }
}

/** 用户反馈：服务端用内嵌的 163 信箱直接寄出去，页面上不出现任何邮箱配置 */
router.post('/feedback', wrap(async (req, res) => {
  const body = req.body ?? {};
  const kind = typeof body.kind === 'string' && ['bug', 'idea', 'other'].includes(body.kind) ? body.kind : 'other';
  const title = String(body.title ?? '').trim();
  const text = String(body.body ?? '').trim();
  const contact = String(body.contact ?? '').trim();
  if (title.length < 2 || title.length > 80) throw new GateError(400, 'BAD_TITLE', '标题写 2 到 80 个字');
  if (text.length < 5 || text.length > 4000) throw new GateError(400, 'BAD_BODY', '内容写 5 到 4000 个字');
  if (contact.length > 120) throw new GateError(400, 'BAD_CONTACT', '联系方式太长了');

  // 只带白名单里的几个字段：整包上报什么都能塞，信就成了一坨没法读的东西
  const extra: Record<string, string> = {};
  const raw = body.extra;
  if (raw && typeof raw === 'object') {
    for (const k of ['合约', '周期', '窗口', '页面', '版本']) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim()) extra[k] = v.trim().slice(0, 200);
    }
  }

  // 校验放在限流前面：填错的人不该被自己刚才那次错填卡住 15 秒。
  // 校验不过根本不会发信，所以这里攒不出邮件洪水
  checkFeedbackRate(req.socket.remoteAddress ?? '');

  try {
    const out = await sendFeedback({ kind, title, body: text, contact, extra });
    console.log('[feedback] 已发出：' + title.slice(0, 40));
    res.json({ ok: true, to: out.to, at: out.at });
  } catch (e) {
    if (e instanceof FeedbackError) throw new GateError(502, e.label, e.message);
    throw e;
  }
}));

/**
 * 拉接口支持的模型列表，省得用户去猜名字。
 * 地址和密钥可以现场传（还没保存也要能拉），不传就用已保存的。
 */
router.post('/ai/models', wrap(async (req, res) => {
  requireLocal(req, '拉模型列表');
  const body = req.body ?? {};
  const override = {
    baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : config.ai.baseUrl,
    apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : config.ai.apiKey,
    model: config.ai.model,
  };
  const models = await listModels(override);
  res.json({ models, current: config.ai.model, endpoint: aiEndpoint(override.baseUrl) });
}));

// ---------- 本机出口 IP ----------

interface IpInfo {
  ok: boolean;
  ip: string;
  country?: string;
  region?: string;
  city?: string;
  isp?: string;
  /** 是哪个查询接口答的，排查时用 */
  source?: string;
  at: number;
  error?: string;
}

/**
 * 本机出网 IP。Gate 的 API 密钥按 IP 白名单时，填的就是这个地址。
 *
 * 由服务端去问，不让浏览器直连：那几个查询接口都不带跨域头。
 * 三家依次兜底，一家挂了换下一家；全挂就如实说，不编一个地址出来。
 */
const IP_SOURCES: { url: string; host: string; pick: (j: Record<string, unknown>) => Omit<IpInfo, 'ok' | 'at' | 'source'> }[] = [
  {
    url: 'https://ipinfo.io/json',
    host: 'ipinfo.io',
    pick: (j) => ({
      ip: String(j.ip ?? ''),
      country: j.country ? String(j.country) : undefined,
      region: j.region ? String(j.region) : undefined,
      city: j.city ? String(j.city) : undefined,
      isp: j.org ? String(j.org) : undefined,
    }),
  },
  {
    url: 'https://api.ip.sb/geoip',
    host: 'api.ip.sb',
    pick: (j) => ({
      ip: String(j.ip ?? ''),
      country: j.country ? String(j.country) : undefined,
      region: j.region ? String(j.region) : undefined,
      city: j.city ? String(j.city) : undefined,
      isp: j.organization ? String(j.organization) : undefined,
    }),
  },
  {
    url: 'https://api.ipify.org?format=json',
    host: 'ipify.org',
    pick: (j) => ({ ip: String(j.ip ?? '') }),
  },
];

/** IPv4 或 IPv6，够用就行；挡掉接口回一句 HTML 被塞进 ip 字段的情况 */
const looksLikeIp = (v: string): boolean => /^[0-9a-fA-F:.]{3,45}$/.test(v) && (v.includes('.') || v.includes(':'));

async function detectIp(direct = false): Promise<IpInfo> {
  for (const src of IP_SOURCES) {
    try {
      const r = await netFetch(
        src.url,
        {
          headers: { accept: 'application/json', 'user-agent': 'xf-rine' },
          signal: AbortSignal.timeout(4000),
        },
        { direct },
      );
      if (!r.ok) continue;
      const got = src.pick(await r.json() as Record<string, unknown>);
      if (looksLikeIp(got.ip)) return { ok: true, ...got, source: src.host, at: Date.now() };
    } catch { /* 这家不通就换下一家 */ }
  }
  return { ok: false, ip: '', at: Date.now(), error: '几个查询接口都没答上来（可能没网，或者被代理拦了）' };
}

/** 同一分钟内重复点就是看同一个结果，别每次都去问三家。只缓存 IP 本身，代理状态一律现取 */
let ipCache: { at: number; info: IpInfo; directIp?: string } | null = null;

router.get('/ip', wrap(async (req, res) => {
  // 出口 IP 是个会变的值，任何一层缓存留着都会让人以为「没重新检测」
  res.set('Cache-Control', 'no-store, max-age=0');
  const fresh = String(req.query.fresh ?? '') === '1';
  // 手动点「重新检测」时连代理状态一起重新确认：用户刚换了代理，这一步要跟上
  if (fresh) await refreshProxy(true);
  if (!fresh && ipCache && Date.now() - ipCache.at < 60_000) {
    res.json({ ...ipCache.info, proxy: proxyState(), ...(ipCache.directIp ? { directIp: ipCache.directIp } : {}) });
    return;
  }

  const info = await detectIp();
  // 代理开着时再问一次直连出口：Gate 的白名单认的是这个地址
  const directInfo = proxyState().on ? await detectIp(true).catch(() => null) : null;
  const directIp = directInfo?.ok ? directInfo.ip : undefined;
  ipCache = { at: Date.now(), info, ...(directIp ? { directIp } : {}) };
  res.json({ ...info, proxy: proxyState(), ...(directIp ? { directIp } : {}) });
}));

router.get('/diag', wrap(async (_req, res) => {
  const out: Record<string, unknown> = {
    env: config.env,
    envLabel: envLabel(),
    restBaseUrl: restBaseUrl(),
    keys: keyHint(),
    liveTrading: config.liveTrading,
  };
  try {
    requireKeys();
    const acct = await gatePrivate<Record<string, unknown>>('GET', '/futures/usdt/accounts');
    out.privateOk = true;
    out.account = acct;
  } catch (e) {
    out.privateOk = false;
    out.privateError = e instanceof GateError ? `${e.label}: ${e.detail}` : String(e);
  }
  res.json(out);
}));

// ---------- 账户与持仓 ----------

interface GatePosition {
  contract: string; size: string; leverage: string; entry_price: string; mark_price: string;
  liq_price: string; unrealised_pnl: string; realised_pnl: string; mode: string; value: string;
}

async function readAccount() {
  const a = await gatePrivate<Record<string, string>>('GET', '/futures/usdt/accounts');
  return {
    total: Number(a.total ?? 0),
    available: Number(a.available ?? 0),
    unrealisedPnl: Number(a.unrealised_pnl ?? 0),
    currency: a.currency ?? 'USDT',
  };
}

router.get('/account', wrap(async (_req, res) => {
  res.json(await readAccount());
}));

/**
 * 读取指定合约的持仓。
 * 单仓模式下 GET /positions/{contract} 返回一个对象（mode='single'）；
 * 双向模式下返回两条 [dual_long, dual_short]。这里统一成「多方向量」。
 */
interface Side {
  direction: Direction;
  size: number;          // 正数，0 表示这一边没有仓
  entryPrice: number;
  markPrice: number;
  liqPrice: number;
  unrealisedPnl: number;
  leverage: number;
  value: number;
}

/**
 * 持仓方向。双向模式的 mode 直接写 dual_long / dual_short。
 * 单向模式只有一个仓，方向藏在 size 的符号里（负数是空头）。
 * 只看 mode 会把单向模式的空单当成多单，反手和加仓就会找错边。
 */
function sideOf(mode: string, size: number): Direction {
  return mode.includes('short') || (!mode.includes('dual') && size < 0) ? 'short' : 'long';
}

async function readSides(contract: string): Promise<Side[]> {
  const raw = await gatePrivate<GatePosition | GatePosition[]>(
    'GET', `/futures/usdt/positions/${encodeURIComponent(contract)}`,
  );
  const rows = Array.isArray(raw) ? raw : [raw];
  const out: Side[] = [];
  for (const p of rows) {
    if (!p) continue;
    const size = Number(p.size ?? 0);
    if (size === 0) continue;
    out.push({
      direction: sideOf(String(p.mode ?? ''), size),
      size: Math.abs(size),
      entryPrice: Number(p.entry_price ?? 0),
      markPrice: Number(p.mark_price ?? 0),
      liqPrice: Number(p.liq_price ?? 0),
      unrealisedPnl: Number(p.unrealised_pnl ?? 0),
      leverage: Number(p.leverage ?? 0),
      value: Number(p.value ?? 0),
    });
  }
  return out;
}

/**
 * 当前所有持仓。
 *
 * 每一条都带上合约乘数：页面要按「(标记价 - 开仓价) × 张数 × 乘数，空头取负」自己现算已盈亏。
 * 只靠每次轮询带回来的那个数，价一动它就已经旧了，而且多空两边看不到同一个口径。
 * 这个式子和交易所的 unrealised_pnl 完全一致（模拟盘上多空各 1 张实测过），所以两边不会打架。
 */
async function readPositions() {
  const list = await gatePrivate<GatePosition[]>('GET', '/futures/usdt/positions');
  /**
   * 按张数过滤，必须转成数字再比。
   *
   * 交易所把 size 写成字符串（"0"），拿它和数字 0 比永远不相等 —— 于是全仓平掉之后
   * 交易所仍保留的那条零张记录会被当成持仓返回，界面上是「0 张 / 开仓 0.0000 /
   * 盈亏 0.00 / 强平价 —」，还会让图上以为这一边有仓。
   */
  return list.filter((p) => Number.isFinite(Number(p.size)) && Number(p.size) !== 0).map((p) => {
    const size = Math.abs(Number(p.size) || 0);
    const mark = Number(p.mark_price) || 0;
    const value = Math.abs(Number(p.value) || 0);
    // 交易所就是这么算持仓价值的：价值 = 张数 × 乘数 × 标记价。
    // 反推乘数比去拉一张上千合约的全表快得多，两者的数完全一致。
    const multiplier = size > 0 && mark > 0 && value > 0 ? Number((value / (size * mark)).toPrecision(6)) : 0;
    return {
      contract: p.contract,
      size,
      direction: sideOf(String(p.mode ?? ''), Number(p.size)),
      leverage: Number(p.leverage),
      entryPrice: Number(p.entry_price),
      markPrice: mark,
      liqPrice: Number(p.liq_price),
      unrealisedPnl: Number(p.unrealised_pnl),
      value,
      mode: p.mode,
      multiplier,
    };
  });
}

router.get('/positions', wrap(async (_req, res) => {
  res.json(await readPositions());
}));

/**
 * 下单时间统一成「秒」。
 * Gate 的 create_time 是带微秒小数的秒（1730000000.123456），
 * 页面那边直接乘 1000 转 Date；单位搞错会让委托列表上的时间变成 1970 年。
 * 这里再兜一层毫秒/微秒的历史格式，免得换个端点就显示成乱码时间。
 */
function unixSeconds(v: unknown): number {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1e14) return n / 1e6; // 微秒
  if (n > 1e11) return n / 1e3; // 毫秒
  return n;
}

async function readOpenOrders(contract?: string) {
  const list = await gatePrivate<Record<string, unknown>[]>('GET', '/futures/usdt/orders', { contract, status: 'open' });
  return list.map((o) => ({
    id: String(o.id),
    contract: String(o.contract),
    size: Number(o.size),
    left: Number(o.left),
    price: Number(o.price),
    fillPrice: Number(o.fill_price),
    status: String(o.status),
    finishAs: o.finish_as ? String(o.finish_as) : null,
    reduceOnly: Boolean(o.is_reduce_only),
    createTime: unixSeconds(o.create_time),
    tif: String(o.tif),
  }));
}

router.get('/orders', wrap(async (req, res) => {
  const contract = req.query.contract ? String(req.query.contract) : undefined;
  res.json(await readOpenOrders(contract));
}));

interface Trigger {
  id: string;
  contract: string;
  /** auto_size 直接写明平哪一边。空字符串表示认不出来（交易所网页上挂的、老的 isclose 单） */
  direction: Direction | '';
  /**
   * 是不是「到价平仓」的保护单。
   * 不能看 reduce_only：Gate 把 auto_size 单回读成 reduce_only: false，
   * 靠它判断会全部落空（实测：自己挂的止损读回来就是 false）。
   * 只有带 auto_size 或 isclose 的才会去平仓；别的触发单是「到价开仓」的条件单，不归保护管。
   */
  protective: boolean;
  /** 原样带回来的 reduce_only，只用来显示 */
  reduceOnly: boolean;
  /** 整边平仓（isclose）。只有这种认不出方向的单才可能需要按合约清掉 */
  closeAll: boolean;
  triggerPrice: number;
  triggerRule: number;
  size: number;
  /** 挂单时间，unix 秒 */
  createTime: number;
  /**
   * 什么时候会被交易所自己撤掉，unix 秒；0 表示不带过期（或读不出来）。
   * 这一项以前完全没读 —— 于是 24 小时一到保护单悄悄消失，
   * 页面上只显示「止损未设」，没人知道是被过期撤掉的。现在把它带到页面上。
   */
  expiresAt: number;
}

/**
 * 保护单的有效期（秒）。
 *
 * Gate 的定义（gateapi-python / gateapi-go 的 FuturesPriceTrigger 文档原文）：
 * 「Maximum wait time for trigger condition (in seconds). Order will be cancelled if timeout」
 * —— 到点交易所自己把止损止盈撤掉，仓就没有保护了。0 的含义文档没写，
 * 不拿真钱去试，所以维持 24 小时；但 expiresAt 会跟着接口回到页面上，
 * 剩多久、什么时候没的，用户必须看得见（见 readTriggers 和页面上的保护提示）。
 */
const PROTECT_EXPIRATION_SEC = 86_400;

async function readTriggers(contract?: string): Promise<Trigger[]> {
  const list = await gatePrivate<Record<string, unknown>[]>('GET', '/futures/usdt/price_orders', { status: 'open' });
  return list.map((o) => {
    const initial = (o.initial ?? {}) as Record<string, unknown>;
    const trigger = (o.trigger ?? {}) as Record<string, unknown>;
    const auto = String(initial.auto_size ?? '');
    const closeAll = Boolean(initial.isclose);
    const expiration = Number(trigger.expiration ?? 0);
    const createTime = unixSeconds(o.create_time);
    return {
      id: String(o.id),
      contract: String(initial.contract ?? ''),
      direction: auto.includes('long') ? 'long' : auto.includes('short') ? 'short' : '',
      protective: closeAll || auto !== '',
      reduceOnly: Boolean(initial.reduce_only),
      closeAll,
      triggerPrice: Number(trigger.price ?? 0),
      triggerRule: Number(trigger.rule ?? 0),
      size: Number(initial.size ?? 0),
      createTime,
      // 交易所到点会自己撤掉，所以到期时刻 = 挂单时间 + 有效期。传 0 才表示没有这一层
      expiresAt: expiration > 0 && createTime > 0 ? createTime + expiration : 0,
    } as Trigger;
  }).filter((t) => !contract || t.contract === contract);
}

router.get('/price-orders', wrap(async (_req, res) => {
  res.json(await readTriggers());
}));

/**
 * 账户、持仓、委托、触发单一次取全。
 *
 * 页面每 3 秒刷一次这些私有数据。分开取要发四个请求，而且四个响应来自四个时刻 ——
 * 持仓和它的止损单可能一个新一个旧，看上去就像「止损没挂上」。
 * 合成一个接口顺带把一次刷新的延迟压到一个往返里。
 */
router.get('/private-state', wrap(async (req, res) => {
  const [account, positions, orders, priceOrders] = await Promise.all([
    readAccount(),
    readPositions(),
    readOpenOrders(),
    readTriggers(),
  ]);
  // armed 让页面每 3 秒对一次账：令牌没了就把「已解锁」收掉，而不是等下一次下单被拒
  res.json({ account, positions, orders, priceOrders, armed: armValid(req) });
}));

// ---------- 平仓、反手之前要清掉的东西 ----------

interface Cleanup {
  /** 撤掉的未成交委托号 */
  orders: string[];
  /** 撤掉的触发单号 */
  triggers: string[];
  errors: string[];
}

const errText = (e: unknown): string => (e instanceof GateError ? `${e.label} ${e.detail}` : String(e));

/**
 * 这张委托会不会动到 dir 这一边。
 * 买 + 减仓 = 平多；卖 + 非减仓 = 开空/加空。其余组合都不是这一边的事。
 */
function touchesSide(size: number, reduceOnly: boolean, dir: Direction): boolean {
  const buy = size > 0;
  if (reduceOnly) return dir === 'long' ? !buy : buy;
  return dir === 'long' ? buy : !buy;
}

/**
 * 把 dir 这一边名下的挂单和触发单撤掉。平仓、反手、开新仓之前都叫它。
 *
 * 非撤不可的原因：
 *   - 触发单是给这个仓位挂的。仓没了它们还留着，下次开同方向的仓，一出现就被这些单打掉，
 *     而且它们永远不会撤，页面上会一直挂着一堆找不到主人的「止损」。
 *   - reduce_only 的限价单同理，仓没了就没有意义；不带 reduce_only 的限价单留着，
 *     会在平完仓之后重新开出一个仓来 —— 你以为已经空仓，实际多了一个没人管的仓。
 *
 * 双向模式下另一边可能还有仓，那时候只动这一边的单：那边还挂着自己的保护单和减仓单。
 * 另一边也空着说明这个合约要清干净了，那就一张不留 —— 单向模式下反向的限价单成交后同样会开仓。
 */
async function cancelSide(contract: string, dirs: Direction[], contractFlat: boolean): Promise<Cleanup> {
  const out: Cleanup = { orders: [], triggers: [], errors: [] };
  // 合约是不是真的空仓了，由调用方按「平仓实际成交了多少」判断，不再靠方向个数猜：
  // 想平两边但只成交了一边时，dirs 会有两个，可另一边其实还裸着。
  const flatAfter = contractFlat;

  let triggers: Trigger[] = [];
  try {
    triggers = await readTriggers(contract);
  } catch (e) {
    out.errors.push(`读触发单失败: ${errText(e)}`);
  }
  for (const t of triggers) {
    // 认不出平哪一边的整边平仓单（isclose），只有在这个合约要清干净时才敢动
    const mine = t.direction ? dirs.includes(t.direction) : t.closeAll && flatAfter;
    if (!mine) continue;
    try {
      await gatePrivate('DELETE', `/futures/usdt/price_orders/${encodeURIComponent(t.id)}`);
      out.triggers.push(t.id);
    } catch (e) {
      out.errors.push(`撤触发单 ${t.id}: ${errText(e)}`);
    }
  }

  let open: Record<string, unknown>[] = [];
  try {
    open = await gatePrivate<Record<string, unknown>[]>('GET', '/futures/usdt/orders', { contract, status: 'open' });
  } catch (e) {
    out.errors.push(`读挂单失败: ${errText(e)}`);
  }
  for (const o of open) {
    const id = String(o.id);
    const size = Number(o.size ?? 0);
    const reduceOnly = Boolean(o.is_reduce_only);
    const mine = flatAfter || dirs.some((d) => touchesSide(size, reduceOnly, d));
    if (!mine) continue;
    try {
      await gatePrivate('DELETE', `/futures/usdt/orders/${encodeURIComponent(id)}`);
      out.orders.push(id);
    } catch (e) {
      out.errors.push(`撤委托 ${id}: ${errText(e)}`);
    }
  }
  return out;
}

/**
 * 开新仓之前，把这一边没人管的触发单清掉。
 * 上一个仓早就没了，留着这些单只会让新仓一出现就被打掉；有仓的时候不动，
 * 那时候的触发单是有主的，覆盖语义归 /api/bracket 管。
 */
async function clearOrphanTriggers(contract: string, dir: Direction): Promise<string[]> {
  const sides = await readSides(contract).catch(() => [] as Side[]);
  if (sides.some((s) => s.direction === dir && s.size > 0)) return [];
  const out: string[] = [];
  for (const t of (await readTriggers(contract)).filter((x) => x.protective && x.direction === dir)) {
    await gatePrivate('DELETE', `/futures/usdt/price_orders/${encodeURIComponent(t.id)}`);
    out.push(t.id);
  }
  return out;
}

// ---------- 交易 ----------

router.post('/trade/arm', wrap(async (req, res) => {
  const { on } = req.body ?? {};
  if (on === false) {
    armTokens.clear();
    res.json({ armed: false });
    return;
  }
  if (!config.liveTrading) throw new GateError(403, 'LIVE_DISABLED', `服务端 LIVE_TRADING=false，先在设置里打开${envLabel()}下单开关`);
  requireKeys();
  const token = randomUUID();
  armTokens.add(token);
  res.json({ armed: true, token });
}));

/**
 * 设杠杆，顺手设保证金模式。
 *
 * Gate 没有单独的「逐仓/全仓」开关：leverage 传非 0 就是逐仓，传 0 就是全仓，
 * 全仓的杠杆放在 cross_leverage_limit 里。所以模式只能从这里设 ——
 * 页面以前只传 leverage，账户又是全仓开的，于是「你以为在逐仓，其实在拿整个余额兜底」。
 * 返回里带上交易所真正接受的那一套，页面照着显示，不自己猜。
 */
router.post('/leverage', wrap(async (req, res) => {
  requireArm(req);
  const { contract: contractRaw, leverage, mode } = req.body ?? {};
  const contract = String(contractRaw ?? '');
  const lev = Math.round(Number(leverage));
  if (!contract || !Number.isFinite(lev)) throw new GateError(400, 'BAD_INPUT', '缺少 contract 或 leverage');
  const c = await tradeContract(contract);
  if (lev < Number(c.leverage_min) || lev > Number(c.leverage_max)) {
    throw new GateError(400, 'LEVERAGE_RANGE', `该合约杠杆范围 ${c.leverage_min} - ${c.leverage_max}`);
  }
  const cross = mode === 'cross';
  // Gate 这个接口参数走 query，不放在 body 里
  const r = await gatePrivate<Record<string, unknown>>(
    'POST',
    `/futures/usdt/positions/${encodeURIComponent(contract)}/leverage`,
    cross ? { leverage: 0, cross_leverage_limit: lev } : { leverage: lev },
  );
  res.json({
    ok: true,
    mode: cross ? 'cross' : 'isolated',
    leverage: Number(r.leverage ?? 0),
    crossLeverageLimit: Number(r.cross_leverage_limit ?? 0),
  });
}));

interface OrderBody {
  contract: string;
  size: number;          // 张数，正数买正数卖由 side 决定
  side: 'long' | 'short';// long = 买入开多 / short = 卖出开空
  price?: number;        // 0 或不传 = 市价
  tif?: 'gtc' | 'ioc' | 'poc' | 'fok';
  reduceOnly?: boolean;
  stop?: number;         // 可选，开仓顺手挂的止损价，0 或不传 = 不挂
  target?: number;       // 可选，开仓顺手挂的止盈价，0 或不传 = 不挂
  /** 逐仓还是全仓。不传按逐仓：账户默认是全仓，不说一声就等于拿整个余额兜底 */
  marginMode?: 'isolated' | 'cross';
  /** 开仓用的杠杆。切保证金模式要一起带上，不然逐仓会用交易所原来的倍数 */
  leverage?: number;
}

interface PlaceSpec {
  contract: string;
  side: Direction;
  /** 正数张数。整边平仓（autoSize）时传 0。 */
  size: number;
  /** 0 或不传 = 市价 */
  price?: number;
  tif?: 'gtc' | 'ioc' | 'poc' | 'fok';
  reduceOnly?: boolean;
  /** 平掉整边：close_long / close_short */
  autoSize?: 'close_long' | 'close_short';
}

interface PreparedOrder {
  info: GateContract;
  payload: Record<string, unknown>;
  price: number;
  isMarket: boolean;
  notional: number;
}

/**
 * 只校验、只拼参数，不发单。
 * 改单必须先拿新参数验一遍再撤旧单 —— 否则新价超出允许偏离时，
 * 校验会失败，而旧单已经被撤掉了，手上什么都没挂。
 */
async function prepareOrder(spec: PlaceSpec): Promise<PreparedOrder> {
  const contract = String(spec.contract);
  // 参数取自下单环境：价格位数、杠杆范围、偏离上限都按那台交易所的规则，不是主网行情的
  const c = await tradeContract(contract);

  if (spec.autoSize) {
    if (Math.round(Number(spec.size)) !== 0) throw new GateError(400, 'BAD_INPUT', '整边平仓不能指定张数');
    return {
      info: c,
      payload: {
        contract, size: 0, price: '0', tif: 'ioc',
        reduce_only: true, close: false, auto_size: spec.autoSize,
      },
      price: Number(c.last_price),
      isMarket: true,
      notional: 0,
    };
  }

  const sizeRaw = Math.round(Number(spec.size));
  if (!Number.isFinite(sizeRaw) || sizeRaw === 0) throw new GateError(400, 'BAD_INPUT', '张数不合法');
  const minSize = Number(c.order_size_min ?? 0);
  const maxSize = Number(c.order_size_max ?? 0);
  if (Math.abs(sizeRaw) < minSize) throw new GateError(400, 'SIZE_MIN', `最小下单 ${c.order_size_min} 张`);
  if (maxSize > 0 && Math.abs(sizeRaw) > maxSize) throw new GateError(400, 'SIZE_MAX', `最大下单 ${c.order_size_max} 张`);

  let price = Number(spec.price ?? 0);
  const isMarket = !Number.isFinite(price) || price <= 0;
  if (isMarket) price = Number(c.last_price);

  // 名义价值只做回执，不限制大小
  const notional = notionalOf(sizeRaw, price, Number(c.quanto_multiplier));

  // 价格偏离保护：限价单价格不能离现价太远，防手滑
  if (!isMarket) {
    const last = Number(c.last_price);
    const deviate = Math.abs(price - last) / last;
    const cap = Math.max(0.05, Number(c.order_price_deviate) || 0.05);
    if (deviate > cap) {
      throw new GateError(400, 'PRICE_DEVIATE', `限价 ${price} 偏离现价 ${(deviate * 100).toFixed(2)}%，超过该合约允许的 ${(cap * 100).toFixed(1)}%`);
    }
    const round = Number(c.order_price_round);
    if (round > 0 && Math.abs(price / round - Math.round(price / round)) > 1e-6) {
      throw new GateError(400, 'PRICE_ROUND', `价格必须是 ${round} 的整数倍`);
    }
    // 吸附到最小变动单位，避免浮点尾巴（73630.40000000001）被交易所拒掉
    price = Number((Math.round(price / round) * round).toFixed(10));
  }

  const signedSize = spec.side === 'long' ? Math.abs(sizeRaw) : -Math.abs(sizeRaw);
  return {
    info: c,
    payload: {
      contract,
      size: signedSize,
      price: isMarket ? '0' : String(price),
      tif: spec.tif ?? (isMarket ? 'ioc' : 'gtc'),
      reduce_only: Boolean(spec.reduceOnly),
    },
    price,
    isMarket,
    notional,
  };
}

/**
 * Gate 拒单时只回一句英文，例如：
 *   margin 6180.18970275 while available 974.218011424088
 * 把两个数取出来，按同样的杠杆算出可用余额够做多少张，再换成中文。
 * 保证金是交易所算的，这里不改判定，只把账说出来。
 */
function explainMargin(e: unknown, prepared: PreparedOrder): unknown {
  if (!(e instanceof GateError)) return e;
  const m = /margin\s+([\d.]+)\s+while\s+available\s+([\d.]+)/i.exec(e.detail);
  if (!m) return e;
  const need = Number(m[1]);
  const avail = Number(m[2]);
  const qty = Math.abs(Number(prepared.payload.size ?? 0));
  if (!(need > 0) || !(avail >= 0) || !(qty > 0)) return e;
  const enough = Math.floor((qty * avail) / need);
  const price = prepared.price;
  return new GateError(
    400,
    'MARGIN_NOT_ENOUGH',
    `${prepared.payload.contract} ${qty} 张 @${price} 要 ${need.toFixed(2)} USDT 保证金，`
    + `账户只有 ${avail.toFixed(2)} USDT，差 ${(need - avail).toFixed(2)}。`
    + `按同样的杠杆，可用余额最多做 ${enough} 张。降张数、提高杠杆，或者先平掉别的仓位。`,
  );
}

/**
 * 开仓前把保证金模式设成用户选的那个。
 *
 * 为什么要在服务端做：页面以前是「先设杠杆、再下单」，那一步失败只弹一句提示就继续发单。
 * 结果是在一个你以为不是的模式里开的仓 —— 逐仓的止损意义完全建立在「亏损不会越过这一笔保证金」上，
 * 模式错了，止损就只是心理安慰。所以这里改成「设不成就不发单」。
 *
 * 这一边已经有持仓时不去动它：交易所本来也不让在有仓的时候改模式，
 * 硬试只会让加仓失败一场。返回里写明没动，页面照着说。
 */
async function ensureMarginMode(
  contract: string, side: Direction, lev: number, mode: 'isolated' | 'cross',
) {
  // 只要这个合约上还有仓（哪一边都算），交易所就不让改模式 —— 硬试只会让加仓失败一场。
  // 所以跳过并把现状说出去，页面照着提示：这一单是照着交易所现有的模式开的。
  const sides = await readSides(contract).catch(() => [] as Side[]);
  if (sides.some((s) => s.size > 0)) {
    return { applied: false as const, mode, why: '这个合约上还有持仓，模式沿用交易所现状' };
  }
  const cross = mode === 'cross';
  try {
    await gatePrivate(
      'POST',
      `/futures/usdt/positions/${encodeURIComponent(contract)}/leverage`,
      cross ? { leverage: 0, cross_leverage_limit: lev } : { leverage: lev },
    );
    return { applied: true as const, mode, leverage: lev };
  } catch (e) {
    const detail = e instanceof GateError ? `${e.label} ${e.detail}` : String(e);
    throw new GateError(
      400,
      'MARGIN_MODE',
      `保证金模式没能设成${cross ? '全仓' : '逐仓'}：${detail}。这一单没有发出去 —— `
      + '模式没切过来就开仓，止损护住的范围和你想的不是一回事。',
    );
  }
}

async function placeOrder(spec: PlaceSpec): Promise<{ prepared: PreparedOrder; order: Record<string, unknown> }> {
  const prepared = await prepareOrder(spec);
  try {
    const order = await gatePrivate<Record<string, unknown>>('POST', '/futures/usdt/orders', {}, prepared.payload);
    return { prepared, order };
  } catch (e) {
    throw explainMargin(e, prepared);
  }
}

const orderReceipt = (order: Record<string, unknown>) => ({
  id: String(order.id),
  contract: String(order.contract),
  size: Number(order.size),
  price: Number(order.price),
  status: String(order.status),
  fillPrice: Number(order.fill_price ?? 0),
});

router.post('/order', wrap(async (req, res) => {
  requireArm(req);
  const body = req.body as Partial<OrderBody> ?? {};
  const contract = String(body.contract ?? '');
  if (!contract) throw new GateError(400, 'BAD_INPUT', '缺少 contract');
  const side: Direction = body.side === 'short' ? 'short' : 'long';
  const stop = Number(body.stop ?? 0) || 0;
  const target = Number(body.target ?? 0) || 0;
  // 开仓前先清掉这一边没人管的触发单（上一个仓已经没了的那种）。
  // 清不掉不影响下单，顶多在回执里少报一项。
  const cleared = body.reduceOnly ? [] : await clearOrphanTriggers(contract, side).catch(() => [] as string[]);
  // 开仓前把保证金模式定下来。平仓（reduceOnly）不动它：平仓和模式无关，白跑一趟还可能被交易所拒。
  const marginMode: 'isolated' | 'cross' = body.marginMode === 'cross' ? 'cross' : 'isolated';
  const openLev = Math.round(Number(body.leverage ?? 0)) || 10;
  const margin = body.reduceOnly ? null : await ensureMarginMode(contract, side, openLev, marginMode);
  const { prepared, order } = await placeOrder({
    contract,
    side,
    size: Number(body.size),
    price: Number(body.price ?? 0),
    tif: body.tif,
    reduceOnly: Boolean(body.reduceOnly),
  });
  // 开仓顺手挂保护。两个价都空着就是纯开仓，不碰现有的触发单。
  const bracket = (stop > 0 || target > 0) && !body.reduceOnly
    ? await attachAfterEntry(contract, side, stop, target)
    : null;
  res.json({
    ok: true,
    order: orderReceipt(order),
    bracket,
    /** 保证金模式设没设上。没设上时这里会写 why，页面要照说 */
    margin,
    /** 开仓前顺手清掉的孤儿触发单 */
    cleared,
    checked: {
      notional: Math.round(prepared.notional * 100) / 100,
      multiplier: Number(prepared.info.quanto_multiplier),
      price: prepared.price,
    },
  });
}));

router.delete('/order/:id', wrap(async (req, res) => {
  requireArm(req);
  await gatePrivate('DELETE', `/futures/usdt/orders/${encodeURIComponent(String(req.params.id))}`);
  res.json({ ok: true });
}));

/**
 * 改单：先校验、再撤旧单、按新条件重挂。
 * 先验后撤，是为了让合法的旧单不因为新参数不合法而平白消失。
 *   1. 把新价新量按下单同一套规则验一遍。验不过就直接报错，旧单还在。
 *   2. 验过了才撤，撤完重挂。挂不上时明确说「旧单已撤」，不留悬念。
 * 张数按剩余量算：已成交的部分不重挂，否则 10 张的委托改个价会变成 12 张。
 */
router.post('/order/:id/amend', wrap(async (req, res) => {
  requireArm(req);
  const id = String(req.params.id);
  const body = req.body ?? {};
  const o = await gatePrivate<Record<string, unknown>>('GET', `/futures/usdt/orders/${encodeURIComponent(id)}`);
  if (!o || !o.id) throw new GateError(404, 'ORDER_NOT_FOUND', '找不到这张委托，可能已经成交或撤掉了');
  if (String(o.status ?? '') !== 'open') {
    throw new GateError(400, 'ORDER_NOT_OPEN', '这张委托已经不在挂着（成交或已撤），改不了了');
  }

  const contract = String(o.contract ?? '');
  const origSize = Number(o.size ?? 0);
  const left = Math.abs(Number(o.left ?? origSize));
  const side: Direction = origSize > 0 ? 'long' : 'short';

  const rawSize = body.size === undefined || body.size === null || body.size === '' ? left : Math.round(Math.abs(Number(body.size)));
  if (!Number.isFinite(rawSize) || rawSize <= 0) throw new GateError(400, 'BAD_INPUT', '张数不合法');
  if (rawSize > left) {
    throw new GateError(400, 'AMEND_SIZE_MAX', `这张单只剩 ${left} 张没成交，改单只能改到 ${left} 张以内。想加大请重新下单`);
  }

  const rawPrice = body.price === undefined || body.price === null || body.price === '' ? Number(o.price ?? 0) : Number(body.price);
  if (!(rawPrice > 0)) throw new GateError(400, 'AMEND_PRICE', '市价单没有价格可改，只能撤掉重下');

  const tif = String(o.tif ?? 'gtc');
  const prepared = await prepareOrder({
    contract,
    side,
    size: rawSize,
    price: rawPrice,
    tif: tif === 'ioc' || tif === 'poc' || tif === 'fok' ? tif : 'gtc',
    reduceOnly: Boolean(o.is_reduce_only),
  });

  // 到这一步新单已经确定挂得出去，才动旧单
  await gatePrivate('DELETE', `/futures/usdt/orders/${encodeURIComponent(id)}`);
  try {
    const order = await gatePrivate<Record<string, unknown>>('POST', '/futures/usdt/orders', {}, prepared.payload);
    res.json({
      ok: true,
      replaced: { oldId: id, ...orderReceipt(order) },
      checked: { price: prepared.price, notional: Math.round(prepared.notional * 100) / 100 },
    });
  } catch (e) {
    const explained = explainMargin(e, prepared);
    const msg = explained instanceof GateError ? `${explained.label} ${explained.detail}` : String(explained);
    throw new GateError(500, 'AMEND_PARTIAL', `旧单已撤，新单没挂上：${msg}。请重新下一单`);
  }
}));

/**
 * 市价平掉这几边，再把这些边名下的委托和触发单撤掉。
 *
 * 顺序是「先平、后撤」：反过来的话，平仓万一被交易所拒了，保护单已经没了，仓就裸着。
 * 先平的风险只在平仓到撤单之间那几毫秒 —— 挂着的委托顶多在这几毫秒里成交。
 */
async function flattenSides(contract: string, wanted: Side[], all: Side[]) {
  const orders: { direction: Direction; size: number; id: string; status: string }[] = [];
  /** 真的平干净了的那几边。没平完的那一边不能撤保护，否则仓还开着却没人管 */
  const closed: Direction[] = [];
  const notFullyClosed: string[] = [];
  for (const s of wanted) {
    const { order } = await placeOrder({
      contract,
      side: s.direction,
      size: 0,
      autoSize: s.direction === 'long' ? 'close_long' : 'close_short',
    });
    const status = String(order.status ?? '');
    const left = Number(order.left ?? 0);
    const done = String(order.finish_as ?? '') === 'filled' || (status === 'finished' && left === 0);
    orders.push({ direction: s.direction, size: s.size, id: String(order.id), status });
    if (done) {
      closed.push(s.direction);
    } else {
      // 盘口太薄时市价平仓只成交一部分。这一边还有仓，保护单必须留着。
      notFullyClosed.push(
        `平${s.direction === 'long' ? '多' : '空'}没完全成交（剩 ${left} 张，状态 ${status || '未知'}），这一边的保护单没有撤`,
      );
    }
  }
  const otherSideHasPosition = all.some((s) => s.size > 0 && !wanted.includes(s));
  const flat = !otherSideHasPosition && closed.length === wanted.length;
  const canceled = await cancelSide(contract, closed, flat);
  canceled.errors.push(...notFullyClosed);
  return { orders, canceled };
}

/**
 * 市价平仓。
 * 不能用 close:true —— 双向持仓模式下 Gate 直接拒绝（POSITION_DUAL_MODE）。
 * auto_size 两种模式都能用：它按方向把整边平掉，单仓模式下也一样。
 *
 * 平仓会连带撤掉这一边的挂单和触发单，回执里列出撤掉了哪些。
 */
router.post('/close-position', wrap(async (req, res) => {
  requireArm(req);
  const { contract: contractRaw, direction } = req.body ?? {};
  if (!contractRaw) throw new GateError(400, 'BAD_INPUT', '缺少 contract');
  const contract = String(contractRaw);
  const sides = await readSides(contract);
  const wanted = sides.filter((s) => s.size > 0 && (!direction || s.direction === direction));
  if (wanted.length === 0) throw new GateError(400, 'NO_POSITION', '当前没有持仓');

  const r = await flattenSides(contract, wanted, sides);
  res.json({ ok: true, ...r });
}));

/**
 * 触发单的价格和现价必须站在正确的一侧。
 * Gate 的触发单是「到条件就市价平」：多头把止损挂在现价上方，挂上去那一秒就成交了。
 * 所以先在服务端拦住，别等交易所平了仓再问为什么。
 *
 * 判定用最新成交价和标记价里更靠里的那个：触发单（price_type 0）看的是最新成交价，
 * 而标记价常常比它更靠里一点。只按标记价判，止损落在这两个价之间时照样一挂就成交 ——
 * 用户会看到「刚挂上就被平了」，那正是最难查的那种 bug。
 */
function checkTriggerPrices(direction: Direction, low: number, high: number, stop: number, target: number): void {
  const below = low > 0 ? low : high;
  const above = high > 0 ? high : low;
  if (stop > 0) {
    if (direction === 'long' && !(stop < below)) {
      throw new GateError(400, 'BAD_STOP', `多头止损要低于现价 ${below}，挂在上方一挂上就成交`);
    }
    if (direction === 'short' && !(stop > above)) {
      throw new GateError(400, 'BAD_STOP', `空头止损要高于现价 ${above}，挂在下方一挂上就成交`);
    }
  }
  if (target > 0) {
    if (direction === 'long' && !(target > above)) {
      throw new GateError(400, 'BAD_TARGET', `多头止盈要高于现价 ${above}，否则一挂上就成交`);
    }
    if (direction === 'short' && !(target < below)) {
      throw new GateError(400, 'BAD_TARGET', `空头止盈要低于现价 ${below}，否则一挂上就成交`);
    }
  }
}

/**
 * 止损 / 止盈：Gate 的「价格触发单」。
 * 多头止损 rule=2（价格 <= 触发价），多头止盈 rule=1（价格 >= 触发价）。
 * 平仓靠 initial.auto_size=close_long / close_short，单仓和双向持仓都吃这套。
 * 老的 order_type: close-long-position 已被 Gate 废弃，传了报 1017。
 *
 * 每次挂都先撤掉这一边已有的触发单（覆盖语义）：不撤的话点两次「套用方案」
 * 就有两套止损，到价时几张单一起打，平出个反向仓来。
 * stop 和 target 都留空 = 只撤不挂，也就是不要保护。
 */
interface BracketResult {
  created: { kind: string; id: string; triggerPrice: number }[];
  canceled: string[];
  errors: string[];
  size: number;
}

/** 按覆盖语义重挂这一边的止损止盈，开仓顺手挂的地方也走这里 */
async function applyBracket(contract: string, dir: Direction, stopRaw: number, targetRaw: number): Promise<BracketResult> {
  const hasStop = Number.isFinite(stopRaw) && stopRaw > 0;
  const hasTarget = Number.isFinite(targetRaw) && targetRaw > 0;

  const sides = await readSides(contract);
  const mine = sides.find((s) => s.direction === dir && s.size > 0) ?? null;
  if (!mine && (hasStop || hasTarget)) {
    throw new GateError(400, 'NO_POSITION', `当前没有${dir === 'long' ? '多' : '空'}头持仓，先有仓才能挂止损止盈`);
  }
  const otherOpen = sides.some((s) => s.direction !== dir && s.size > 0);

  const c = await tradeContract(contract);
  const last = Number(c.last_price) || 0;
  const mark = mine && mine.markPrice > 0 ? mine.markPrice : last;

  const round = Number(c.order_price_round);
  const snap = (p: number) => (round > 0 ? Math.round(Math.round(p / round) * round * 1e8) / 1e8 : p);

  // 先吸附到最小变动价，再判方向：止损离现价不到一个 tick 时，
  // 吸附会把它推到现价上，按原值判「严格在下方」会放行，挂上去那一秒就成交。
  const stop = hasStop ? snap(stopRaw) : 0;
  const target = hasTarget ? snap(targetRaw) : 0;
  if (stop > 0 || target > 0) {
    checkTriggerPrices(dir, Math.min(last || mark, mark), Math.max(last, mark), stop, target);
  }

  const canceled: string[] = [];
  const errors: string[] = [];
  // 认不出方向的整边平仓单（交易所网页上挂的 isclose）在对边空着时也只可能属于这一边。
  // 只撤「减仓/平仓」这一类：交易所网页上挂的条件开仓单不归这里管，覆盖保护时不该顺手把它删了。
  const existing = (await readTriggers(contract)).filter(
    (t) => t.protective && (t.direction === dir || (t.direction === '' && t.closeAll && !otherOpen)),
  );
  for (const t of existing) {
    try {
      await gatePrivate('DELETE', `/futures/usdt/price_orders/${encodeURIComponent(t.id)}`);
      canceled.push(t.id);
    } catch (e) {
      errors.push(`撤旧单 ${t.id}: ${e instanceof GateError ? `${e.label} ${e.detail}` : String(e)}`);
    }
  }

  const jobs: { kind: 'stop' | 'target'; price: number; rule: 1 | 2 }[] = [];
  if (stop > 0) jobs.push({ kind: 'stop', price: stop, rule: dir === 'long' ? 2 : 1 });
  if (target > 0) jobs.push({ kind: 'target', price: target, rule: dir === 'long' ? 1 : 2 });

  const created: { kind: string; id: string; triggerPrice: number }[] = [];
  for (const job of jobs) {
    try {
      const r = await gatePrivate<Record<string, unknown>>('POST', '/futures/usdt/price_orders', {}, {
        initial: {
          contract,
          size: 0,
          price: '0',
          tif: 'ioc',
          reduce_only: true,
          close: false,
          // auto_size 指明平哪一边，单仓和双向持仓都吃这套；isclose 在双向模式下有歧义
          auto_size: dir === 'long' ? 'close_long' : 'close_short',
        },
        trigger: { strategy: 0, price_type: 0, price: String(job.price), rule: job.rule, expiration: PROTECT_EXPIRATION_SEC },
      });
      created.push({ kind: job.kind, id: String(r.id), triggerPrice: job.price });
    } catch (e) {
      errors.push(`${job.kind}: ${e instanceof GateError ? `${e.label} ${e.detail}` : String(e)}`);
    }
  }

  // 想挂的没挂上就明说。只想撤的时候没撤掉也一样。
  if (jobs.length > 0 && created.length === 0 && errors.length > 0) {
    throw new GateError(400, 'BRACKET_FAILED', errors.join(' | '));
  }
  if (jobs.length === 0 && errors.length > 0) {
    throw new GateError(400, 'CANCEL_FAILED', errors.join(' | '));
  }
  return { created, canceled, errors, size: mine?.size ?? 0 };
}

/**
 * 开仓顺手挂保护。只有开了仓才挂得上，所以先读持仓再决定。
 * 限价单还没成交时返回 pending，前端记下来，等持仓出现再补挂。
 */
async function attachAfterEntry(contract: string, dir: Direction, stop: number, target: number) {
  for (let i = 0; i < 3; i++) {
    const sides = await readSides(contract).catch(() => [] as Side[]);
    if (sides.some((s) => s.direction === dir && s.size > 0)) {
      try {
        const r = await applyBracket(contract, dir, stop, target);
        // 止损挂上、止盈没挂上也算「没挂全」。原来这里一律报 attached，
        // 页面就显示「保护单已挂」，可实际上少了一边 —— 止损没挂上是会赔钱的。
        return { status: r.errors.length > 0 ? ('partial' as const) : ('attached' as const), ...r };
      } catch (e) {
        return { status: 'failed' as const, error: e instanceof GateError ? `${e.label} ${e.detail}` : String(e) };
      }
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 250));
  }
  return { status: 'pending' as const };
}

router.post('/bracket', wrap(async (req, res) => {
  requireArm(req);
  const { contract: contractRaw, direction, stop, target } = req.body ?? {};
  if (!contractRaw || !['long', 'short'].includes(String(direction))) {
    throw new GateError(400, 'BAD_INPUT', '缺少 contract 或 direction');
  }
  const r = await applyBracket(String(contractRaw), direction as Direction, Number(stop ?? 0), Number(target ?? 0));
  res.json({ ok: r.errors.length === 0, ...r });
}));

/**
 * 加仓：在已有那一侧按市价再加张数。
 * 张数只做交易所的最小/最大校验，不设仓位上限 —— 加多少该由当天的行情决定。
 * 单向模式下同方向的委托会直接加在现有仓上，双向模式下加在对应的那一侧。
 */
router.post('/add-position', wrap(async (req, res) => {
  requireArm(req);
  const { contract: contractRaw, direction, size, price } = req.body ?? {};
  if (!contractRaw || !['long', 'short'].includes(String(direction))) {
    throw new GateError(400, 'BAD_INPUT', '缺少 contract 或 direction');
  }
  const contract = String(contractRaw);
  const dir = direction as Direction;
  const qty = Math.round(Math.abs(Number(size)));
  if (!Number.isFinite(qty) || qty <= 0) throw new GateError(400, 'BAD_INPUT', '张数不合法');

  const sides = await readSides(contract);
  const mine = sides.find((s) => s.direction === dir && s.size > 0);
  if (!mine) {
    throw new GateError(400, 'NO_POSITION', `当前没有${dir === 'long' ? '多' : '空'}头持仓。开新仓请用下单面板`);
  }

  const { prepared, order } = await placeOrder({ contract, side: dir, size: qty, price: Number(price ?? 0) });
  res.json({
    ok: true,
    order: orderReceipt(order),
    added: qty,
    checked: { notional: Math.round(prepared.notional * 100) / 100, price: prepared.price },
  });
}));

/**
 * 反手：市价平掉这一边，再按同样的张数开反方向。
 * Gate 没有「一键反手」接口，只能两步。第一步没成交就停手 ——
 * 平仓没成功还去开反向，等于凭空多一倍仓，那是最糟的结果。
 */
router.post('/reverse-position', wrap(async (req, res) => {
  requireArm(req);
  const { contract: contractRaw, direction, size } = req.body ?? {};
  if (!contractRaw || !['long', 'short'].includes(String(direction))) {
    throw new GateError(400, 'BAD_INPUT', '缺少 contract 或 direction');
  }
  const contract = String(contractRaw);
  const dir = direction as Direction;

  const sides = await readSides(contract);
  const mine = sides.find((s) => s.direction === dir && s.size > 0);
  if (!mine) {
    throw new GateError(400, 'NO_POSITION', `当前没有${dir === 'long' ? '多' : '空'}头持仓，没有可反的仓`);
  }
  const qty = Math.round(Math.abs(Number(size ?? mine.size)));
  if (!Number.isFinite(qty) || qty <= 0) throw new GateError(400, 'BAD_INPUT', '张数不合法');
  if (qty > mine.size) {
    throw new GateError(400, 'REVERSE_SIZE_MAX', `反向张数不能超过当前持仓的 ${mine.size} 张。想加大请反手之后再点加仓`);
  }

  const opposite: Direction = dir === 'long' ? 'short' : 'long';
  const label = (d: Direction) => (d === 'long' ? '多' : '空');

  const close = await placeOrder({
    contract,
    side: dir,
    size: 0,
    autoSize: dir === 'long' ? 'close_long' : 'close_short',
  });
  const closeStatus = String(close.order.status ?? '');
  const closeLeft = Number(close.order.left ?? 0);
  const closedOut = String(close.order.finish_as ?? '') === 'filled' || (closeStatus === 'finished' && closeLeft === 0);
  if (!closedOut || closeLeft > 0) {
    throw new GateError(
      400,
      'REVERSE_STOPPED',
      `平${label(dir)}没有完全成交（剩 ${closeLeft} 张，状态 ${closeStatus || '未知'}），已经停手，没有开反方向`,
    );
  }

  // 平掉的那一边，委托和触发单跟着一起撤。不撤的话，同一秒反向开的仓一出现，
  // 旧止损（auto_size 平的是刚平掉的那一边，价格又刚好在现价这侧）就会把新仓打掉。
  // 这一边已经平干净了。反方向没有仓时整个合约就空着，可以一张不留地清干净。
  const canceled = await cancelSide(contract, [dir], !sides.some((s) => s.direction === opposite && s.size > 0));

  try {
    const { order } = await placeOrder({ contract, side: opposite, size: qty });
    res.json({
      ok: true,
      closed: { id: String(close.order.id), size: mine.size, status: closeStatus },
      opened: orderReceipt(order),
      direction: opposite,
      size: qty,
      canceled,
    });
  } catch (e) {
    const msg = e instanceof GateError ? `${e.label} ${e.detail}` : String(e);
    throw new GateError(
      500,
      'REVERSE_PARTIAL',
      `${label(dir)}已经平掉，反向开${label(opposite)} ${qty} 张失败：${msg}。现在这一边是空仓，请手动补一次`,
    );
  }
}));

router.delete('/price-order/:id', wrap(async (req, res) => {
  requireArm(req);
  await gatePrivate('DELETE', `/futures/usdt/price_orders/${encodeURIComponent(String(req.params.id))}`);
  res.json({ ok: true });
}));

interface GateTicker {
  contract: string; last: string; mark_price: string; change_percentage: string;
  volume_24h_quote: string; funding_rate: string; quanto_multiplier: string; total_size: string;
}

// ---------- 当前环境能交易哪些合约 ----------

let tradableCache: { env: string; at: number; names: Set<string> | null } = { env: '', at: 0, names: null };

/**
 * 当前环境可交易的合约名单。实盘就是主网全量（返回 null 表示不做限制）；
 * 测试网要去测试网自己的公开接口拿 —— 它只上架了几十个。
 */
async function tradableNames(): Promise<Set<string> | null> {
  if (config.env !== 'testnet') return null;
  if (tradableCache.env === config.env && Date.now() - tradableCache.at < 5 * 60_000) return tradableCache.names;
  try {
    const res = await netFetch(restBaseUrl() + '/api/v4/futures/usdt/contracts', { headers: { Accept: 'application/json' } });
    if (!res.ok) return tradableCache.names;
    const list = (await res.json()) as { name?: string; status?: string }[];
    const names = new Set(list.filter((c) => c.name && c.status !== 'delisted').map((c) => String(c.name)));
    tradableCache = { env: config.env, at: Date.now(), names };
    return names;
  } catch {
    return tradableCache.names; // 拿不到就别拦，让交易所自己报错
  }
}

interface TickerRow {
  contract: string; last: number; mark: number; change24h: number; volume24hUsd: number;
  fundingRate: number; multiplier: number; openInterest: number; priceRound: number; tradable: boolean;
}

/** 全部行情也是一大坨，拉一次十几秒。缓存起来，页面每 12 秒问一次就直接给上次的，后台换新的 */
let tickerCache: { at: number; rows: TickerRow[] } | null = null;
let tickerBusy: Promise<void> | null = null;

function refreshTickers(): Promise<void> {
  if (tickerBusy) return tickerBusy;
  tickerBusy = (async () => {
    const [list, tradable] = await Promise.all([
      gatePublic<GateTicker[]>('/futures/usdt/tickers', {}, 60_000, 45_000),
      tradableNames().catch(() => null),
    ]);
    // 拉不到合约元数据不影响行情，只是价格精度退回默认值
    const roundOf = new Map(contractsNow().map((c) => [c.name, Number(c.order_price_round)]));
    tickerCache = {
      at: Date.now(),
      rows: list
        .filter((t) => Number(t.last) > 0)
        .map((t) => ({
          contract: t.contract,
          last: Number(t.last),
          mark: Number(t.mark_price),
          change24h: Number(t.change_percentage),
          volume24hUsd: Number(t.volume_24h_quote),
          fundingRate: Number(t.funding_rate),
          multiplier: Number(t.quanto_multiplier),
          openInterest: Number(t.total_size),
          priceRound: roundOf.get(t.contract) ?? 0,
          // 测试网里没上架的合约标出来，别让人点了半天才发现下不了单
          tradable: tradable === null ? true : tradable.has(t.contract),
        }))
        .sort((a, b) => b.volume24hUsd - a.volume24hUsd),
    };
  })()
    .catch((e) => {
      const why = e instanceof Error ? e.message : String(e);
      console.error('[tickers] 拉全量行情失败：' + why.slice(0, 200));
    })
    .finally(() => { tickerBusy = null; });
  return tickerBusy;
}

router.get('/tickers', wrap(async (_req, res) => {
  if (!tickerCache) {
    // 冷启动最多等 10 秒。再久就先把空列表给出去 —— 页面每 12 秒会再问一次，
    // 让第一屏挂在这儿一分钟，看起来就是「币种一直加载不出来」。
    await Promise.race([
      refreshTickers(),
      new Promise<void>((done) => { const t = setTimeout(done, 10_000); t.unref?.(); }),
    ]);
  } else if (Date.now() - tickerCache.at > 15_000) void refreshTickers();
  res.json(tickerCache?.rows ?? []);
}));

export type { Direction };

/**
 * 研究台接口（/research/*）：数据目录、单品种分析、全市场扫描。
 *
 * 放在文件末尾挂载：它依赖的 wrap / fail / requireLocal 都在上面定义，
 * 提前调用会踩到 const 的暂时性死区（启动即 ReferenceError）。
 */
mountResearch(router, {
  getDataDir: readDataDir,
  fail,
  wrap: (fn) => wrap(fn),
});

/**
 * 回测研究台（/quant/*）。
 * 和研究台同一个理由放在文件末尾：它依赖 requireLocal / wrap，
 * 提前调用会踩到 const 的暂时性死区。
 */
mountQuant(router, { wrap: (fn) => wrap(fn), requireLocal });

// ---------- AI 交易（/ai/strategy、/ai/decide、/ai/decisions、/ai/status） ----------

/**
 * 执行器要用的四件事，全部走这里已有的那几段代码。
 *
 * 放在文件末尾是为了避开 const 的暂时性死区：buildSnapshot / placeOrder /
 * ensureMarginMode / attachAfterEntry / readAccount / readPositions 都在上面定义，
 * 在它们之前实例化会启动即 ReferenceError（和研究台那段同一个理由）。
 */
const aiDeps: RunnerDeps = {
  snapshot: (contract, interval) => buildSnapshot(contract, interval),

  contractMeta: async (contract) => {
    const c = await tradeContract(contract);
    return {
      multiplier: Number(c.quanto_multiplier),
      sizeMin: Number(c.order_size_min),
      sizeMax: Number(c.order_size_max),
      leverageMax: Number(c.leverage_max),
      takerFee: Number(c.taker_fee_rate),
      lastPrice: Number(c.last_price),
    };
  },

  account: async () => {
    const a = await readAccount();
    return { total: a.total, available: a.available };
  },

  /**
   * 把 strategyId 翻成"哪个币、什么周期、过没过回测"。
   *
   * 执行器每一轮都要问一次，所以这里只读本地 JSON，不碰交易所 —— 一次读几 KB，
   * 比让执行器自己缓存一份"策略可能已经被改了"的副本安全。
   */
  binding: (strategyId: string) => {
    const saved = getSavedStrategy(strategyId);
    if (!saved) return null;
    return {
      contract: saved.contract,
      interval: saved.interval,
      passed: saved.lastRun ? saved.lastRun.passed : null,
      failed: saved.lastRun ? saved.lastRun.failed : [],
      enoughSample: saved.lastRun ? saved.lastRun.enoughSample : false,
      // 策略类型决定实盘怎么出方向 —— 这两条以前缺失，导致执行器只会走那套旧协议
      kind: saved.kind,
      spec: saved.spec,
      prompt: saved.prompt,
    };
  },

  /**
   * 最近若干根已收盘 K 线，转成回测引擎用的形状。
   *
   * 去掉最后一根：它还没走完，最高最低还会变，拿它判断条件等于用未完成的数据做决定。
   */
  recentCandles: async (contract: string, interval: string, count: number) => {
    const { bars } = await loadCandles(contract, interval, count);
    return bars.slice(0, -1).map((b) => ({
      t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
    }));
  },

  askModel: async (system: string, user: string) => {
    const r = await chatJson({ system, user, maxTokens: 300, timeoutMs: 60_000 });
    return r.text;
  },

  openPositions: async () => {
    const list = await readPositions();
    // Direction 这个类型里还有 'both'（引擎那边分方向用的），这里只要多空两边
    return list.map((p) => ({
      contract: p.contract,
      direction: (p.direction === 'short' ? 'short' : 'long') as 'long' | 'short',
      size: p.size,
    }));
  },

  /**
   * 发单。和 POST /order 走同一条路：清孤儿触发单 → 定保证金模式 → 验参下单 → 挂保护。
   *
   * 不一样的地方只有一处：这里没有 x-arm-token。AI 拿不到浏览器那把锁，
   * 它的授权是「AI 交易页上的开关」加上下面那两道门（服务端下单开关、实盘确认）。
   */
  execute: async (req: ExecRequest) => {
    const dir: Direction = req.side === 'short' ? 'short' : 'long';
    // 开仓前先把这一边没人管的触发单清掉，否则新仓一出现就会被上一个仓的遗物打掉
    await clearOrphanTriggers(req.contract, dir).catch(() => [] as string[]);
    // 模式设不成就不发单：逐仓的止损要建立在「亏损不会越过这一笔保证金」上
    await ensureMarginMode(req.contract, dir, req.leverage, req.marginMode);
    const isLimit = req.entryType === 'limit' && req.entry !== null && req.entry > 0;
    const { prepared, order } = await placeOrder({
      contract: req.contract,
      side: dir,
      size: req.size,
      price: isLimit ? (req.entry ?? 0) : 0,
      tif: isLimit ? 'gtc' : undefined,
    });
    // 限价单还没成交时这里会返回 pending，AI 不做「等它成交再补挂」那一套：
    // 限价单的成交与否属于下一轮判断，写进回执让页面看见就行
    const bracket = (req.stop > 0 || req.target > 0)
      ? await attachAfterEntry(req.contract, dir, req.stop, req.target)
      : null;
    return {
      id: String(order.id),
      // Gate 的市价单会直接回 fill_as（ioc 成交完就是 'ioc'），挂单才是 'open'
      status: String(order.fill_as ?? order.status ?? 'open'),
      fillPrice: Number(order.fill_price ?? 0) || prepared.price,
      size: Math.abs(Number(order.size ?? 0)),
      bracket,
    };
  },
};

const aiRunner = new AiRunner(aiDeps);
// 定时器先起着：策略没开的时候它每 30 秒只读一次那个小 JSON，什么都不做。
// 不这么写的话，「打开开关」那次请求之后的第一个决策要等用户手动点一次才开始。
aiRunner.start();

/** 把策略和状态一起给出去：页面只需要一次请求就能把整块画出来 */
const aiPayload = () => ({
  strategy: loadStrategy(),
  status: aiRunner.status(),
  /** 策略库：页面上的"选策略"格子里要列出来 */
  strategies: listSavedStrategies(),
  /** 当前绑定的那条策略的细节（合约、周期、上次回测过没过），没选就是 null */
  binding: (() => {
    const id = loadStrategy().strategyId;
    const s = id ? getSavedStrategy(id) : null;
    return s ? bindingOf(s) : null;
  })(),
  path: AI_STRATEGY_PATH,
  ai: { configured: Boolean(config.ai.apiKey), baseUrl: config.ai.baseUrl, model: config.ai.model },
  liveTrading: config.liveTrading,
});

router.get('/ai/strategy', (req, res) => {
  res.json(aiPayload());
});

/**
 * 写策略。这一格管的是钱，所以：
 *   · 只认本机（和写密钥、选数据目录同一个理由）；
 *   · 打开开关之前先验「能不能交易」：AI 没配、密钥没填、实盘没确认，一律拒，并说清是哪一条。
 *
 * 注意没有「只出建议」这个档。开关是二值的：开着就按策略下单，关掉就一个请求都不发。
 */
router.post('/ai/strategy', wrap(async (req, res) => {
  requireLocal(req, '改 AI 策略');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const current = loadStrategy();
  const merged = sanitizeStrategy(body, current);
  // 熔断是运行期状态，不该由页面顺手改掉；要解只能在页面上明确点「解除熔断」
  merged.haltReason = body.resetHalt === true ? '' : current.haltReason;
  merged.haltUntil = body.resetHalt === true ? 0 : current.haltUntil;
  merged.dayKey = current.dayKey;
  merged.dayStartEquity = current.dayStartEquity;

  /**
   * 合约池和周期**永远**由策略决定，不管开没开。
   *
   * 放在 if (enabled) 里面是错的：关着的时候页面显示的空合约池就是真的空，
   * 打开开关那一次才落定，中间那段显示的状态和实际要跑的不是一回事。
   * 而且页面直接传的 contracts 一律不认 —— 上面那句 sanitize 里读的是调用方给的，
   * 这里再覆盖一次，确保"只有策略能决定在哪个币上跑"。
   */
  /*
   * 策略不再锁死币种。
   *
   * 以前这里强制 merged.contracts = [bound.contract]，理由是"策略只在训练过的币上有依据"。
   * 现在放开：换币是合理需求（同一套规则想在别的品种上看看）。
   * 但"依据变弱"这件事不能悄悄吞掉 —— 页面上会并排显示
   * 「策略上次回测的合约」和「现在要跑的合约」，不一致就提示重跑一次。
   * 策略上没记合约时，才用策略的默认合约兜底。
   */
  const bound = merged.strategyId ? getSavedStrategy(merged.strategyId) : null;
  if (bound && merged.contracts.length === 0) merged.contracts = [bound.contract];

  if (merged.enabled) {
    if (!config.ai.apiKey) {
      throw new GateError(400, 'AI_NOT_CONFIGURED', '还没有配置 AI 密钥（设置页 → AI），没有模型就没法决策');
    }

    /**
     * 必须先选一条过了回测的策略。
     *
     * 这一条替代了原来那句「合约池是空的」。区别在于：以前合约池是手填的，
     * 填什么就能拿什么下单；现在合约池由策略决定，而策略必须先在回测里达标。
     * "选一条策略"和"决定在哪个币上跑"是同一件事，不该分两步问。
     */
    const gate = checkRunnable(merged, bound ? bindingOf(bound) : null);
    if (!gate.ok) {
      throw new GateError(400, 'STRATEGY_NOT_READY', gate.reason);
    }

    /**
     * 合约得在当前环境里真的能交易。
     *
     * 模拟盘只上架几十个合约，主网一千多 —— 在模拟盘里选一个只在主网有的合约，
     * 前面一路绿灯，直到下单那一刻才被交易所回一句 CONTRACT_NOT_FOUND。
     * 在这里一次说清，比让用户猜「哪个环节不认这个币」强。
     */
    if (merged.contracts.length > 0) {
      const tradable = await tradableNames().catch(() => null);
      if (tradable) {
        const missing = merged.contracts.filter((c) => !tradable.has(c));
        if (missing.length > 0) {
          throw new GateError(
            400, 'CONTRACT_NOT_TRADABLE',
            (config.env === 'testnet' ? '模拟盘' : '实盘') + '上没有 ' + missing.join('、')
            + ' 这个合约。模拟盘只上架了几十个，换一个，或者先切到实盘再开',
          );
        }
      }
    }

    requireKeys();
    if (config.env === 'live' && !merged.liveConfirmed) {
      throw new GateError(
        400, 'LIVE_NOT_CONFIRMED',
        '当前是实盘。要让 AI 用真钱下单，得先在这一页勾上「确认实盘」—— 换环境会把它清掉',
      );
    }
    if (merged.haltUntil > Date.now()) {
      throw new GateError(
        400, 'HALTED',
        '还在熔断中：' + (merged.haltReason || '日内亏损到上限') + '。要重新开始，先点「解除熔断」',
      );
    }
  }

  const saved = saveStrategy(merged);
  if (saved.enabled) aiRunner.start();
  else aiRunner.stop();
  res.json({ ok: true, ...aiPayload() });
}));

router.get('/ai/status', (_req, res) => {
  res.json({ ...aiPayload(), recent: aiRunner.records(1) });
});

router.get('/ai/decisions', (req, res) => {
  const n = Math.min(200, Math.max(1, Number(req.query.limit ?? 40) || 40));
  res.json({ records: aiRunner.records(n), status: aiRunner.status() });
});

/**
 * 立即决策一次。
 *
 * 只在策略开着的时候可用。关着的时候「帮你看一眼」就是建议单 —— 那个东西这里不做，
 * 所以这里直接拒，而不是悄悄跑一次然后把结论摆出来。
 */
router.post('/ai/decide', wrap(async (_req, res) => {
  const cfg = loadStrategy();
  if (!cfg.enabled) throw new GateError(400, 'AI_DISABLED', 'AI 交易没开。先在这一页打开开关，它才会决策');
  const rec = await aiRunner.tick(true);
  if (!rec) {
    res.json({ ok: false, skip: aiRunner.status().skip, status: aiRunner.status() });
    return;
  }
  res.json({ ok: true, record: rec, ...aiPayload() });
}));

/**
 * 急停：关掉开关、停掉定时器，但保留日志和策略 —— 回来还能接着用。
 * 这和「切环境」不一样：那个连实盘确认一起清掉，这个是暂时的。
 */
router.post('/ai/halt', wrap(async (req, res) => {
  requireLocal(req, '停 AI 交易');
  aiRunner.stop();
  const cfg = loadStrategy();
  const halt = (req.body ?? {}).halt === true;
  const saved = saveStrategy(
    halt
      ? { ...cfg, enabled: false, haltReason: '手动急停', haltUntil: Date.now() + 24 * 3600_000 }
      : { ...cfg, enabled: false },
  );
  res.json({ ok: true, strategy: saved, status: aiRunner.status() });
}));

