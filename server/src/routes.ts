import { Router, type Request, type Response } from 'express';
import type { CandlesResponse, ContractInfo, LevelsResponse, Ticker } from '@xfrine/contract';
import { config, envLabel, exchangeLabel } from './config.js';
import { GateError } from './exchange/errors.js';
import { exchange } from './exchange/index.js';
import type { XContract, XTicker, XCandle } from './exchange/types.js';
import { isLoopbackAddress } from './httpSecurity.js';
import type { Bar } from './bar.js';
import type { Direction, MtfGroup, Zone } from './sr/types.js';
import { stabilizeZones, zoneKey } from './sr/memory.js';
import { BackupError } from './backup.js';
import * as sr from './sr/client.js';
import { SidecarError } from './sr/client.js';
import { mountResearch } from './sr/research.js';
import { mountQuant } from './quant/routes.js';
import { mountSystemRoutes } from './systemRoutes.js';
import { mountTradeRoutes } from './tradeRoutes.js';
import { mountAiTradingRoutes } from './aiTradingRoutes.js';
import { newsDigest } from './news.js';
import { analyze, testConnection, AiError, type AiSnapshot } from './ai.js';
import { DataError } from './errors.js';
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

function seriesFor(rawKey: string): BarSeries {
  /**
   * 缓存键带上交易所：两家的 K 线不是同一份数据（成交量、极值都不一样），
   * 而且换交易所之后合约名虽然一样，背后是另一个市场。混着用等于把两家的历史拼成一根线。
   */
  const key = config.exchange + ':' + rawKey;
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
  if (!isLoopbackAddress(req.socket.remoteAddress ?? '')) {
    throw new GateError(403, 'LOCAL_ONLY', `${what}只允许本机访问`);
  }
}

/** 两个环境各自的密钥状态，设置页要一次看到两套 */
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

function fail(res: Response, err: unknown): void {
  if (err instanceof AiError) {
    res.status(err.status === 200 ? 400 : err.status).json({ error: err.label, detail: err.detail });
    return;
  }
  if (err instanceof GateError) {
    res.status(err.status === 200 ? 400 : err.status).json({ error: err.label, detail: err.detail, status: err.status });
    return;
  }
  // 备份的报错（密码错、文件坏了、格式不认识）都是「你给的东西不对」，不是服务端崩了
  if (err instanceof BackupError) {
    res.status(400).json({ error: 'BACKUP', detail: err.message, status: 400 });
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
  // Bitget 的 40014 可能是「读持仓」权限不足，不能把它直接说成缺少写权限。
  // /private-state 会同时读取账户、持仓、委托和保护单；把读权限错报为写权限，
  // 会让用户误以为修好了写权限就能下单，却仍然看不到持仓。
  const bitgetPositionPermission = e.from === 'Bitget'
    && (e.label === '40014' || /need future pos (?:read|write) permissions/i.test(e.detail));
  if (bitgetPositionPermission) {
    const where = '到 Bitget「API 管理」检查当前这把密钥的合约仓位读取权限；要下单还需开启「合约交易 · 读写」';
    return new GateError(
      403,
      'KEY_POSITION_PERMISSION',
      `Bitget 拒绝了合约私有接口：当前 API Key 缺少所需的合约仓位权限。${where}。`
      + `现在使用的是 ${exchangeLabel()} ${envLabel()} 密钥。`,
      'Bitget',
    );
  }

  const writePermission = e.label === 'READ_ONLY'
    || /does not have futures write permission|futures? write permission|trade write permission|not authorized to trade|read-only api key/i
      .test(`${e.label} ${e.detail}`);
  if (writePermission) {
    const where = config.exchange === 'bitget'
      ? '到 Bitget 的「API 管理」里给这把钥匙勾上「合约交易 · 读写」（要下单就勾读写），保存后重下一次就行'
      : '到 Gate 的「API 管理」里把这把钥匙的权限改成「合约交易 · 读写」并保存，密钥本身不用换，改完重下一次就行';
    return new GateError(
      403,
      'KEY_NO_WRITE',
      '这把 API 密钥没有「合约交易」写权限，设杠杆、下单、平仓都会被交易所拒掉'
      + '（读行情、看账户是好的，所以页面上看不出问题）。'
      + where + '。'
      + `现在用的是${exchangeLabel()} ${envLabel()}那套密钥，改的也是它。`,
    );
  }

  /**
   * Bitget 的拒单码对用户没有意义，挑几个常被撞上的翻成人话。
   * 43012 = 保证金不足，40774 = 持仓方向对不上（多半是单向/双向持仓模式不一致）。
   */
  if (e.from === 'Bitget') {
    if (e.label === '43012' || /insufficient.*(margin|balance)/i.test(String(e.detail))) {
      return new GateError(
        400, 'MARGIN_NOT_ENOUGH',
        `保证金不够：${e.detail}。降张数、提高杠杆，或者先平掉别的仓位。`,
        'Bitget',
      );
    }
    if (e.label === '40774' || /position.*(side|direction)/i.test(String(e.detail))) {
      return new GateError(
        400, 'POSITION_SIDE',
        `持仓方向对不上：${e.detail}。`
        + 'Bitget 的「单向持仓 / 双向持仓」是在网页或 App 的合约设置里定的，'
        + '这边按账户当前的模式下单；先到 Bitget 上确认一下这个合约是哪种模式，再重试。',
        'Bitget',
      );
    }
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

  // 模拟盘只上架了几十个合约 —— 这是 Gate 测试网的情况，Bitget 的模拟盘是全量
  if (e.label !== 'CONTRACT_NOT_FOUND' || config.env !== 'testnet' || config.exchange !== 'gate') return e;
  return new GateError(
    400,
    'NOT_IN_TESTNET',
    '这个合约在模拟盘没有上市。测试网只上架了几十个合约（主网有一千多个），'
    + '换成主流币，或者到设置页切到实盘再下单。',
  );
}

// ---------- 合约与行情 ----------

/**
 * 合约、持仓、挂单、行情这几种形状现在跟交易所无关了（定义在 exchange/types.ts）。
 * 名字还叫 Gate* 是因为整个文件几万行都按这些字段名写，改一遍没有任何收益。
 */
type GateContract = XContract;

/**
 * 合约元数据（最小变动、杠杆上限、手续费）不常变，缓存一分钟。
 * 行情接口要按合约取最小变动价，每 12 秒拉一次全表太浪费。
 */
let contractCache: { at: number; exchange: string; list: GateContract[] } | null = null;
let contractBusy: Promise<void> | null = null;
let contractRetry: NodeJS.Timeout | null = null;

/** 整张合约表一个多 MB，国内直连要几秒到十几秒 —— 所以拉到就一直留着，过一小时才重拉 */
function refreshContracts(): Promise<void> {
  if (contractBusy) return contractBusy;
  contractBusy = (async () => {
    // 这张表 1.4 MB、直连实测三十秒上下。超时给足，失败要说出来 ——
    // 以前这里静默吞掉，结果整个进程活着期间都是空表：最小变动价拿不到，
    // 「按比例算张数」也在猜，界面上却一个字都不提。
    const list = await exchange().contracts(90_000, 90_000);
    contractCache = { at: Date.now(), exchange: config.exchange, list };
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
  // 换过交易所就当作没缓存：两家上架的合约和最小变动价都不一样
  if (!contractCache || contractCache.exchange !== config.exchange
    || Date.now() - contractCache.at > 60 * 60_000) void refreshContracts();
  return contractCache?.exchange === config.exchange ? contractCache.list : [];
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
  // 键里带交易所：同一个 BTC_USDT 在两家是两份不同的合约参数
  const key = config.exchange + ':' + name;
  const hit = tradeContractCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.c;
  const c = await exchange().tradeContract(name);
  tradeContractCache.set(key, { at: Date.now(), c });
  return c;
}


router.get('/contracts/:name', wrap(async (req, res) => {
  const name = String(req.params.name);
  const [c, tradable] = await Promise.all([
    exchange().publicContract(name),
    tradableNames(),
  ]);
  /**
   * 按 @xfrine/contract 的 ContractInfo 写，而不是随手 res.json 一个字面量：
   * 字段改名、加字段忘了同步页面时，tsc 在这里就报，不用等到页面读到 undefined。
   */
  const body: ContractInfo = {
    // 当前环境（尤其模拟盘）能不能交易它
    tradable: tradable === null ? true : tradable.has(c.name),
    name: c.name,
    multiplier: Number(c.quanto_multiplier),
    sizeMin: Number(c.order_size_min) > 0 ? c.order_size_min : (c.size_step ?? 1),
    sizeStep: c.size_step ?? 1,
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
  };
  res.json(body);
}));

type GateCandle = XCandle;

/**
 * 去交易所要一页。
 *
 * Gate 的 to 是闭区间：给 to=X、limit=1000，拿到的是 [X-999根, X]，含 X 那根。
 * 我们要的是「X 之前的 1000 根」，所以 to 得往前挪一根 —— 否则那 1000 根里有一根
 * 是重复的 X，丢掉之后只剩 999 根，接缝处就少一根，图上看着是断的。
 */
async function fetchPage(contract: string, interval: string, limit: number, step: number, before?: number): Promise<Bar[]> {
  // to 是「早于这个时刻」的秒数。适配器按各家的写法翻（Bitget 要毫秒的 endTime）
  const raw = await exchange().candles(contract, interval, limit, before ? before - step : undefined);
  return raw
    .map((c) => ({
      time: Number(c.t),
      open: Number(c.o),
      high: Number(c.h),
      low: Number(c.l),
      close: Number(c.c),
      volume: Number(c.v),
      turnover: c.turnover ?? (c.sum == null ? undefined : Number(c.sum)),
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
  const body: CandlesResponse = {
    contract,
    interval,
    bars: page.bars,
    hasMore: page.bars.length >= limit,
    exhausted: page.exhausted,
    // 这段历史中间有洞（上游少给）。前端的自愈和体检脚本按它判断，不影响正常画图
    gap: page.gap === true,
  };
  res.json(body);
}));

// ---------- 档位 ----------

/** 高周期共振位最多画几条：再多就把本周期那几条压住了 */
const MTF_EXTRA_MAX = 4;

/**
 * 邻居周期（30m / 1h / 4h）算出来的位。
 *
 * 引擎在主周期上只聚出它自己那几个簇，周线级别的那条支撑压根不会出现 ——
 * 「该有的位没有」多半是这一类。这些位其实一直在算，只是以前只用来给本周期的位
 * 打一个「共振」标记，图上一条都没画。这里挑几个不和本周期重位的画出来，带上周期名。
 *
 * 和本周期已有的位差不到半个 ATR 就不画：那是同一个位置，画两遍只会把图压乱。
 */
function mtfExtras(groups: MtfGroup[], current: Zone[], live: number, atr: number): Zone[] {
  if (!(live > 0) || groups.length === 0) return [];
  const unit = atr > 0 ? atr : Math.max(live * 0.003, 1e-9);
  const out: Zone[] = [];
  for (const g of groups) {
    for (const raw of g.zones ?? []) {
      const role: Zone['zone_type'] = raw.high < live ? 'support'
        : raw.low > live ? 'resistance'
          : raw.center <= live ? 'support' : 'resistance';
      const z: Zone = {
        ...raw,
        zone_type: role,
        zone_label: (g.tf_label || g.tf) + (role === 'support' ? ' 支撑' : ' 压力'),
        distance_pct: Number((((raw.center - live) / live) * 100).toFixed(4)),
        distance_atr: Number(((raw.center - live) / unit).toFixed(4)),
        from_tf: g.tf_label || g.tf,
      };
      if (current.some((c) => Math.abs(c.center - z.center) < unit * 0.5)) continue;
      if (out.some((o) => Math.abs(o.center - z.center) < unit * 0.5)) continue;
      out.push(z);
    }
  }
  // 离现价最近的几条优先：远处的位对当下这一单没有意义
  out.sort((a, b) => Math.abs(a.center - live) - Math.abs(b.center - live));
  return out.slice(0, MTF_EXTRA_MAX);
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
  // 每侧 4 个：原来 3 个的时候，最近那个摆动高低点经常被挤掉，看着就是「该有的位没有」
  const nZones = Math.round(qnum(req.query.n_zones ?? req.query.maxOut, 4, 1, 8));
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
    /**
     * 交给记忆层：位置钉住、角色带迟滞、上次有这次没有的位留成历史。
     * 不这么做的话，档位每分钟重算一次，图上的线就跟着漂一次、旧线还会整条消失。
     */
    const set = stabilizeZones(zoneKey(config.exchange, r.symbol, r.tf, dir, nZones), r.zones, {
      atr: r.engine.atr, live: r.current_price,
    });
    const zones = set.current;
    const body: LevelsResponse = {
      contract: r.symbol,
      interval: r.tf,
      source: 'local',
      barsUsed: r.data_bars,
      last: r.current_price,
      atr: r.engine.atr,
      zones,
      // 之前出现过、这次没重算出来的位：页面画淡一点，别让它凭空消失
      historyZones: set.history,
      // 邻居周期算出来的位：本周期看不出来的周线级别支撑就在这里
      mtfZones: mtfExtras(r.mtf_zones, zones, r.current_price, r.engine.atr),
      nearestSupport: nearestOf(zones, 'support'),
      nearestResistance: nearestOf(zones, 'resistance'),
      summary: r.summary,
      engine: r.engine,
      mtf_zones: r.mtf_zones,
    };
    res.json(body);
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
  const set = stabilizeZones(zoneKey(config.exchange, contract, interval, dir, nZones), r.zones, {
    atr: r.engine.atr, live: live || r.current_price,
  });
  const zones = set.current;
  const body: LevelsResponse = {
    contract,
    interval,
    source: 'gate',
    barsUsed: closed.length,
    last: live || r.current_price,
    atr: r.engine.atr,
    zones,
    historyZones: set.history,
    mtfZones: mtfExtras(r.mtf_zones, zones, live || r.current_price, r.engine.atr),
    nearestSupport: nearestOf(zones, 'support'),
    nearestResistance: nearestOf(zones, 'resistance'),
    summary: r.summary,
    engine: r.engine,
    mtf_zones: r.mtf_zones,
  };
  res.json(body);
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
  // 研究台和日内台共用同一份目录状态，切换页面时保持一致。
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
  // 和 /levels 用同一个记忆层：模型嘴里的价位必须和图上画的是同一批
  const zones = stabilizeZones(zoneKey(config.exchange, contract, tfCode, 'both', 3), analysis.zones, {
    atr: analysis.engine.atr, live,
  }).current;
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
  if (!isLoopbackAddress(req.socket.remoteAddress ?? '')) {
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


const tradeServices = mountTradeRoutes(router, {
  wrap,
  requireArm,
  requireLocal,
  armTokens,
  armValid,
  translate,
  tradeContract,
});
type GateTicker = XTicker;

// ---------- 当前环境能交易哪些合约 ----------

let tradableCache: { env: string; exchange: string; at: number; names: Set<string> | null } =
  { env: '', exchange: '', at: 0, names: null };

/**
 * 当前环境可交易的合约名单。实盘就是主网全量（返回 null 表示不做限制）；
 * 测试网要去测试网自己的公开接口拿 —— 它只上架了几十个。
 */
async function tradableNames(
  selectedExchange = config.exchange,
  selectedEnv = config.env,
  adapter = exchange(),
): Promise<Set<string> | null> {
  if (selectedEnv !== 'testnet') return null;
  if (tradableCache.env === selectedEnv && tradableCache.exchange === selectedExchange
    && Date.now() - tradableCache.at < 5 * 60_000) return tradableCache.names;
  try {
    const names = await adapter.tradableNames();
    // null = 这家不做限制（Bitget 的模拟盘和实盘是同一套合约）
    if (!names) return null;
    if (config.env === selectedEnv && config.exchange === selectedExchange) {
      tradableCache = { env: selectedEnv, exchange: selectedExchange, at: Date.now(), names };
    }
    return names;
  } catch {
    return tradableCache.env === selectedEnv && tradableCache.exchange === selectedExchange
      ? tradableCache.names
      : null; // 拿不到就别拦，让交易所自己报错
  }
}

/**
 * 服务端手里这一行。
 *
 * 在契约的 Ticker 之上把乘数、未平仓、最小变动价这几个定死 —— 内部算账时它们必须存在，
 * 而页面上读的是可选字段。extends 而不是再抄一份：契约加字段，这里跟着就要求填。
 */
interface TickerRow extends Ticker {
  multiplier: number;
  openInterest: number;
  priceRound: number;
  tradable: boolean;
}

/** 全部行情也是一大坨，拉一次十几秒。缓存起来，页面每 12 秒问一次就直接给上次的，后台换新的 */
let tickerCache: { at: number; exchange: string; env: string; rows: TickerRow[] } | null = null;
const tickerBusy = new Map<string, Promise<void>>();

function refreshTickers(): Promise<void> {
  const selectedExchange = config.exchange;
  const selectedEnv = config.env;
  const scope = `${selectedExchange}:${selectedEnv}`;
  const pending = tickerBusy.get(scope);
  if (pending) return pending;

  const adapter = exchange();
  let task: Promise<void>;
  task = (async () => {
    const [list, tradable] = await Promise.all([
      adapter.tickers(60_000, 45_000),
      tradableNames(selectedExchange, selectedEnv, adapter).catch(() => null),
    ]);
    if (config.exchange !== selectedExchange || config.env !== selectedEnv) return;
    /**
     * 合约表还没到位时价格精度会是 0，页面上价格就成了整数（63570 而不是 63570.0）。
     * 刚启动、或者刚换过交易所（旧表已经判为无效）时都会碰上，这里最多等它 3 秒。
     */
    if (contractsNow().length === 0) {
      await Promise.race([
        refreshContracts().catch(() => undefined),
        new Promise<void>((done) => { const t = setTimeout(done, 3000); t.unref?.(); }),
      ]);
    }
    if (config.exchange !== selectedExchange || config.env !== selectedEnv) return;
    const roundOf = new Map(contractsNow().map((c) => [c.name, Number(c.order_price_round)]));
    tickerCache = {
      at: Date.now(),
      exchange: selectedExchange,
      env: selectedEnv,
      // 按契约的 Ticker 写：页面读得到、也算得出的字段都在这里，别两处各记一份
      rows: list
        .filter((t) => Number(t.last) > 0)
        .map((t): TickerRow => ({
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
    .finally(() => {
      if (tickerBusy.get(scope) === task) tickerBusy.delete(scope);
    });
  tickerBusy.set(scope, task);
  return task;
}

router.get('/tickers', wrap(async (_req, res) => {
  // 换过交易所：手上这份是另一家的行情，不能给出去
  if (tickerCache && (tickerCache.exchange !== config.exchange || tickerCache.env !== config.env)) tickerCache = null;
  if (!tickerCache) {
    // 冷启动最多等 10 秒。再久就先把空列表给出去 —— 页面每 12 秒会再问一次，
    // 让第一屏挂在这儿一分钟，看起来就是「币种一直加载不出来」。
    await Promise.race([
      refreshTickers(),
      new Promise<void>((done) => { const t = setTimeout(done, 10_000); t.unref?.(); }),
    ]);
  } else if (Date.now() - tickerCache.at > 15_000) void refreshTickers();
  res.json(tickerCache?.exchange === config.exchange && tickerCache.env === config.env ? tickerCache.rows : []);
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

const { aiRunner } = mountAiTradingRoutes(router, {
  wrap,
  requireLocal,
  tradeServices,
  tradeContract,
  buildSnapshot,
  loadCandles: (contract, interval, count) => loadCandles(contract, interval, count),
  tradableNames,
});
mountSystemRoutes(router, {
  wrap,
  requireLocal,
  armTokens,
  stopAiRunner: () => aiRunner.stop(),
});
