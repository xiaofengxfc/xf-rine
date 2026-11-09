import { Router, type Request, type Response } from 'express';
import { config, keyHint, keyHintFor, writeEnv, restBaseUrl, envLabel, keySlot, aiKeyHint, aiEndpoint, type GateEnv } from './config.js';
import { gatePublic, gatePrivate, GateError, requireKeys } from './gate/rest.js';
import { detectLevels, planBracket, type Bar, type Bracket, type Direction } from './levels.js';
import { newsDigest } from './news.js';
import { detectPatterns } from './patterns.js';
import { analyze, testConnection, listModels, AiError, type AiSnapshot } from './ai.js';
import { randomUUID } from 'node:crypto';

export const router = Router();

const barCache = new Map<string, { at: number; bars: Bar[] }>();
const INTERVALS = new Set(['10s', '1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '7d']);

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
const armTokens = new Map<string, number>();
const ARM_TTL_MS = 10 * 60 * 1000;

function requireArm(req: Request): void {
  const t = String(req.header('x-arm-token') ?? '');
  const exp = armTokens.get(t);
  if (!exp || exp < Date.now()) throw new GateError(403, 'NOT_ARMED', '未解锁交易，请先在页面右上角点「解锁交易」');
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
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: 'INTERNAL', detail: msg });
}

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => { fn(req, res).catch((e) => fail(res, e)); };

// ---------- 合约与行情 ----------

interface GateContract {
  name: string; quanto_multiplier: string; order_size_min: number; order_size_max: number;
  order_price_round: string; mark_price_round: string; leverage_min: string; leverage_max: string;
  last_price: string; mark_price: string; funding_rate: string; funding_rate_indicative: string;
  funding_interval: number; in_delisting: boolean; status: string; position_size: number;
  taker_fee_rate: string; maker_fee_rate: string; order_price_deviate: string;
}

router.get('/contracts', wrap(async (_req, res) => {
  const list = await gatePublic<GateContract[]>('/futures/usdt/contracts');
  res.json(list
    .filter((c) => c.status === 'trading' && !c.in_delisting)
    .map((c) => ({
      name: c.name,
      multiplier: Number(c.quanto_multiplier),
      sizeMin: c.order_size_min,
      sizeMax: c.order_size_max,
      priceRound: Number(c.order_price_round),
      leverageMax: Number(c.leverage_max),
      price: Number(c.last_price),
      markPrice: Number(c.mark_price),
      fundingRate: Number(c.funding_rate),
      fundingInterval: c.funding_interval,
      openInterest: c.position_size,
      takerFee: Number(c.taker_fee_rate),
      makerFee: Number(c.maker_fee_rate),
    }))
    .sort((a, b) => b.price * b.multiplier - a.price * a.multiplier));
}));

router.get('/contracts/:name', wrap(async (req, res) => {
  const name = String(req.params.name);
  const c = await gatePublic<GateContract>(`/futures/usdt/contracts/${encodeURIComponent(name)}`);
  res.json({
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

async function loadCandles(contract: string, interval: string, limit: number, fresh = false): Promise<Bar[]> {
  const key = `${contract}:${interval}:${limit}`;
  const hit = barCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 4000) return hit.bars;
  const raw = await gatePublic<GateCandle[]>('/futures/usdt/candlesticks', { contract, interval, limit });
  const bars: Bar[] = raw.map((c) => ({
    time: Number(c.t),
    open: Number(c.o),
    high: Number(c.h),
    low: Number(c.l),
    close: Number(c.c),
    volume: Number(c.v),
  }));
  barCache.set(key, { at: Date.now(), bars });
  return bars;
}

router.get('/candles', wrap(async (req, res) => {
  const contract = String(req.query.contract ?? 'BTC_USDT');
  const interval = INTERVALS.has(String(req.query.interval)) ? String(req.query.interval) : '1m';
  const limit = Math.min(1000, Math.max(50, Number(req.query.limit ?? 500)));
  const bars = await loadCandles(contract, interval, limit);
  res.json({ contract, interval, bars });
}));

router.get('/levels', wrap(async (req, res) => {
  const contract = String(req.query.contract ?? 'BTC_USDT');
  const interval = INTERVALS.has(String(req.query.interval)) ? String(req.query.interval) : '15m';
  const limit = Math.min(1000, Math.max(120, Number(req.query.limit ?? 500)));
  const bars = await loadCandles(contract, interval, limit);
  // 丢掉最后一根未走完的 K 线，避免用半根 K 线的影线判位
  const closed = bars.slice(0, -1);
  const set = detectLevels(closed, {
    pivotWindow: Math.max(2, Math.round(Number(req.query.pivotWindow ?? 3))),
    maxLevels: Math.min(16, Math.max(3, Number(req.query.maxLevels ?? 8))),
    maxDistancePct: Math.min(50, Math.max(1, Number(req.query.maxDistancePct ?? 12))),
    minStrength: Math.min(90, Math.max(0, Number(req.query.minStrength ?? 25))),
  });
  const minRR = Math.max(0.5, Number(req.query.minRR ?? 1.5));
  const live = bars[bars.length - 1]?.close ?? set.last;
  const setForPlan = { ...set, last: live };
  res.json({
    contract,
    interval,
    barsUsed: closed.length,
    ...setForPlan,
    patterns: detectPatterns(closed, { window: 30, limit: 6 }),
    brackets: {
      long: planBracket(setForPlan, 'long', { minRR }),
      short: planBracket(setForPlan, 'short', { minRR }),
    },
  });
}));

// ---------- 新闻雷达 ----------

router.get('/news', wrap(async (req, res) => {
  const contract = String(req.query.contract ?? 'BTC_USDT').toUpperCase();
  const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 8)));
  res.json(await newsDigest(contract, limit));
}));

// ---------- AI 分析 ----------

/** 价格留 6 位有效数字就够了，原始浮点白烧 token 还容易被读错 */
const px = (v: number): number => (Number.isFinite(v) ? Number(v.toPrecision(6)) : 0);

const roundBracket = (b: Bracket | null): Bracket | null =>
  b ? { ...b, entry: px(b.entry), stop: px(b.stop), target: px(b.target), riskReward: Number(b.riskReward.toFixed(2)) } : null;

async function buildSnapshot(contract: string, interval: string): Promise<AiSnapshot> {
  const bars = await loadCandles(contract, interval, 300);
  const closed = bars.slice(0, -1);
  const set = detectLevels(closed, {});
  const live = bars[bars.length - 1]?.close ?? set.last;
  const planSet = { ...set, last: live };
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
    atr: px(set.atr),
    rangeHigh: px(set.rangeHigh),
    rangeLow: px(set.rangeLow),
    barsUsed: closed.length,
    spanHours: Number((t1 > t0 ? (t1 - t0) / 3600 : 0).toFixed(1)),
    barHigh: px(barHigh),
    barLow: px(barLow),
    change24h: Number(change24h.toFixed(2)),
    levels: set.levels.map((l) => ({
      price: px(l.price),
      // 模型读中文材料，角色也给它中文
      role: l.role === 'support' ? '支撑' : '阻力',
      strength: Math.round(l.strength),
      touches: l.touches,
      failures: l.failures,
      distancePct: Number(l.distancePct.toFixed(2)),
    })),
    brackets: {
      long: roundBracket(planBracket(planSet, 'long', { minRR: 1.5 })),
      short: roundBracket(planBracket(planSet, 'short', { minRR: 1.5 })),
    },
    patterns: detectPatterns(closed, { window: 12, limit: 4 }).map((p) => ({
      name: p.name,
      direction: p.direction,
      note: p.note,
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
  res.json(await analyze(snapshot, { refresh: req.body?.refresh === true }));
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

router.get('/config', (_req, res) => {
  res.json({
    env: config.env,
    envLabel: envLabel(),
    restBaseUrl: restBaseUrl(),
    keys: keyHint(),
    keysByEnv: keysByEnv(),
    liveTrading: config.liveTrading,
    limits: { maxLeverage: config.maxLeverage, maxContracts: config.maxContracts },
    ai: {
      configured: aiKeyHint().configured,
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      hint: aiKeyHint().hint,
      endpoint: aiEndpoint(),
    },
    armed: false,
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

router.get('/diag', wrap(async (_req, res) => {
  const out: Record<string, unknown> = {
    env: config.env,
    envLabel: envLabel(),
    restBaseUrl: restBaseUrl(),
    keys: keyHint(),
    liveTrading: config.liveTrading,
    limits: { maxLeverage: config.maxLeverage },
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
  contract: string; size: number; leverage: string; entry_price: string; mark_price: string;
  liq_price: string; unrealised_pnl: string; realised_pnl: string; mode: string; value: string;
}

router.get('/account', wrap(async (_req, res) => {
  const a = await gatePrivate<Record<string, string>>('GET', '/futures/usdt/accounts');
  res.json({
    total: Number(a.total ?? 0),
    available: Number(a.available ?? 0),
    unrealisedPnl: Number(a.unrealised_pnl ?? 0),
    currency: a.currency ?? 'USDT',
  });
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

async function readSides(contract: string): Promise<Side[]> {
  const raw = await gatePrivate<GatePosition | GatePosition[]>(
    'GET', `/futures/usdt/positions/${encodeURIComponent(contract)}`,
  );
  const rows = Array.isArray(raw) ? raw : [raw];
  const out: Side[] = [];
  for (const p of rows) {
    if (!p) continue;
    const dualShort = String(p.mode ?? '').includes('short');
    out.push({
      direction: dualShort ? 'short' : 'long',
      size: Math.abs(Number(p.size ?? 0)),
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

router.get('/positions', wrap(async (_req, res) => {
  const list = await gatePrivate<GatePosition[]>('GET', '/futures/usdt/positions');
  res.json(list.filter((p) => p.size !== 0).map((p) => {
    const dualShort = String(p.mode ?? '').includes('short');
    return {
      contract: p.contract,
      size: Math.abs(p.size),
      direction: dualShort ? 'short' : 'long',
      leverage: Number(p.leverage),
      entryPrice: Number(p.entry_price),
      markPrice: Number(p.mark_price),
      liqPrice: Number(p.liq_price),
      unrealisedPnl: Number(p.unrealised_pnl),
      value: Math.abs(Number(p.value)),
      mode: p.mode,
    };
  }));
}));

router.get('/orders', wrap(async (req, res) => {
  const contract = req.query.contract ? String(req.query.contract) : undefined;
  const list = await gatePrivate<Record<string, unknown>[]>('GET', '/futures/usdt/orders', { contract, status: 'open' });
  res.json(list.map((o) => ({
    id: String(o.id),
    contract: String(o.contract),
    size: Number(o.size),
    left: Number(o.left),
    price: Number(o.price),
    fillPrice: Number(o.fill_price),
    status: String(o.status),
    finishAs: o.finish_as ? String(o.finish_as) : null,
    reduceOnly: Boolean(o.is_reduce_only),
    createTime: Number(o.create_time),
    tif: String(o.tif),
  })));
}));

router.get('/price-orders', wrap(async (_req, res) => {
  const list = await gatePrivate<Record<string, unknown>[]>('GET', '/futures/usdt/price_orders', { status: 'open' });
  res.json(list.map((o) => {
    const initial = (o.initial ?? {}) as Record<string, unknown>;
    const trigger = (o.trigger ?? {}) as Record<string, unknown>;
    const auto = String(initial.auto_size ?? '');
    return {
      id: String(o.id),
      contract: String(initial.contract ?? ''),
      // auto_size 直接写明平哪一边，比 rule 推断可靠
      direction: auto.includes('long') ? 'long' : auto.includes('short') ? 'short' : '',
      reduceOnly: Boolean(initial.reduce_only) || Boolean(initial.isclose),
      triggerPrice: Number(trigger.price ?? 0),
      triggerRule: Number(trigger.rule ?? 0),
      size: Number(initial.size ?? 0),
    };
  }));
}));

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
  armTokens.set(token, Date.now() + ARM_TTL_MS);
  res.json({ armed: true, token, expiresAt: Date.now() + ARM_TTL_MS });
}));

router.post('/leverage', wrap(async (req, res) => {
  requireArm(req);
  const { contract, leverage } = req.body ?? {};
  const lev = Math.round(Number(leverage));
  if (!contract || !Number.isFinite(lev)) throw new GateError(400, 'BAD_INPUT', '缺少 contract 或 leverage');
  if (lev > config.maxLeverage) throw new GateError(403, 'LEVERAGE_CAP', `杠杆超过服务端上限 ${config.maxLeverage}`);
  const c = await gatePublic<GateContract>(`/futures/usdt/contracts/${encodeURIComponent(contract)}`);
  if (lev < Number(c.leverage_min) || lev > Number(c.leverage_max)) {
    throw new GateError(400, 'LEVERAGE_RANGE', `该合约杠杆范围 ${c.leverage_min} - ${c.leverage_max}`);
  }
  // Gate 这个接口参数走 query，不放在 body 里
  const r = await gatePrivate<Record<string, unknown>>('POST', `/futures/usdt/positions/${encodeURIComponent(contract)}/leverage`, { leverage: lev });
  res.json({ ok: true, leverage: r.leverage ?? lev });
}));

interface OrderBody {
  contract: string;
  size: number;          // 张数，正数买正数卖由 side 决定
  side: 'long' | 'short';// long = 买入开多 / short = 卖出开空
  price?: number;        // 0 或不传 = 市价
  tif?: 'gtc' | 'ioc' | 'poc' | 'fok';
  reduceOnly?: boolean;
}

router.post('/order', wrap(async (req, res) => {
  requireArm(req);
  const body = req.body as Partial<OrderBody> ?? {};
  const contract = String(body.contract ?? '');
  const sizeRaw = Math.round(Number(body.size));
  const side = body.side === 'short' ? 'short' : 'long';
  if (!contract) throw new GateError(400, 'BAD_INPUT', '缺少 contract');
  if (!Number.isFinite(sizeRaw) || sizeRaw === 0) throw new GateError(400, 'BAD_INPUT', '张数不合法');

  const c = await gatePublic<GateContract>(`/futures/usdt/contracts/${encodeURIComponent(contract)}`);
  const multiplier = Number(c.quanto_multiplier);
  let price = Number(body.price ?? 0);
  const isMarket = !Number.isFinite(price) || price <= 0;
  if (isMarket) price = Number(c.last_price);

  if (Math.abs(sizeRaw) < c.order_size_min) throw new GateError(400, 'SIZE_MIN', `最小下单 ${c.order_size_min} 张`);
  if (Math.abs(sizeRaw) > c.order_size_max) throw new GateError(400, 'SIZE_MAX', `最大下单 ${c.order_size_max} 张`);
  if (config.maxContracts > 0 && Math.abs(sizeRaw) > config.maxContracts) {
    throw new GateError(403, 'SIZE_CAP', `超过服务端单笔张数上限 ${config.maxContracts} 张`);
  }

  // 名义价值只做回执，不再限制大小
  const notional = notionalOf(sizeRaw, price, multiplier);

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
  }

  // 吸附到最小变动单位，避免浮点尾巴（73630.40000000001）被交易所拒掉
  if (!isMarket) {
    const round = Number(c.order_price_round);
    if (round > 0) price = Number((Math.round(price / round) * round).toFixed(10));
  }

  const signedSize = side === 'long' ? Math.abs(sizeRaw) : -Math.abs(sizeRaw);
  const payload: Record<string, unknown> = {
    contract,
    size: signedSize,
    price: isMarket ? '0' : String(price),
    tif: body.tif ?? (isMarket ? 'ioc' : 'gtc'),
    reduce_only: Boolean(body.reduceOnly),
  };

  const order = await gatePrivate<Record<string, unknown>>('POST', '/futures/usdt/orders', {}, payload);
  res.json({
    ok: true,
    order: {
      id: String(order.id),
      contract: String(order.contract),
      size: Number(order.size),
      price: Number(order.price),
      status: String(order.status),
      fillPrice: Number(order.fill_price ?? 0),
    },
    checked: { notional: Math.round(notional * 100) / 100, multiplier, price },
  });
}));

router.delete('/order/:id', wrap(async (req, res) => {
  requireArm(req);
  await gatePrivate('DELETE', `/futures/usdt/orders/${encodeURIComponent(String(req.params.id))}`);
  res.json({ ok: true });
}));

/**
 * 市价平仓。
 * 不能用 close:true —— 双向持仓模式下 Gate 直接拒绝（POSITION_DUAL_MODE）。
 * auto_size 两种模式都能用：它按方向把整边平掉，单仓模式下也一样。
 */
router.post('/close-position', wrap(async (req, res) => {
  requireArm(req);
  const { contract, direction } = req.body ?? {};
  if (!contract) throw new GateError(400, 'BAD_INPUT', '缺少 contract');
  const sides = await readSides(String(contract));
  const wanted = sides.filter((s) => s.size > 0 && (!direction || s.direction === direction));
  if (wanted.length === 0) throw new GateError(400, 'NO_POSITION', '当前没有持仓');

  const orders: { direction: Direction; size: number; id: string; status: string }[] = [];
  for (const s of wanted) {
    const o = await gatePrivate<Record<string, unknown>>('POST', '/futures/usdt/orders', {}, {
      contract,
      size: 0,
      price: '0',
      tif: 'ioc',
      reduce_only: true,
      close: false,
      auto_size: s.direction === 'long' ? 'close_long' : 'close_short',
    });
    orders.push({ direction: s.direction, size: s.size, id: String(o.id), status: String(o.status) });
  }
  res.json({ ok: true, orders });
}));

/**
 * 止损 / 止盈：Gate 的「价格触发单」。
 * 多头止损 rule=2（价格 <= 触发价），多头止盈 rule=1（价格 >= 触发价）。
 * 平仓靠 initial.isclose=true。老的 order_type: close-long-position 已被 Gate 废弃，传了报 1017。
 */
router.post('/bracket', wrap(async (req, res) => {
  requireArm(req);
  const { contract, direction, stop, target, size } = req.body ?? {};
  if (!contract || !['long', 'short'].includes(direction)) throw new GateError(400, 'BAD_INPUT', '缺少 contract 或 direction');
  const sides = await readSides(String(contract));
  const mine = sides.find((s) => s.direction === direction && s.size > 0);
  if (!mine) {
    throw new GateError(400, 'NO_POSITION', `当前没有${direction === 'long' ? '多' : '空'}头持仓，先有仓才能挂止损止盈`);
  }
  const posSize = mine.size;
  const want = Number(size ?? posSize);
  const qty = Math.min(posSize, Math.max(1, Math.round(want)));

  const c = await gatePublic<GateContract>(`/futures/usdt/contracts/${encodeURIComponent(String(contract))}`);
  const round = Number(c.order_price_round);
  const snap = (p: number) => (round > 0 ? Math.round(Math.round(p / round) * round * 1e8) / 1e8 : p);

  const created: { kind: string; id: string; triggerPrice: number }[] = [];
  const errors: string[] = [];

  const jobs: { kind: 'stop' | 'target'; price: number; rule: 1 | 2 }[] = [];
  if (Number(stop) > 0) jobs.push({ kind: 'stop', price: snap(Number(stop)), rule: direction === 'long' ? 2 : 1 });
  if (Number(target) > 0) jobs.push({ kind: 'target', price: snap(Number(target)), rule: direction === 'long' ? 1 : 2 });

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
          auto_size: direction === 'long' ? 'close_long' : 'close_short',
        },
        trigger: { strategy: 0, price_type: 0, price: String(job.price), rule: job.rule, expiration: 86400 },
      });
      created.push({ kind: job.kind, id: String(r.id), triggerPrice: job.price });
    } catch (e) {
      errors.push(`${job.kind}: ${e instanceof GateError ? `${e.label} ${e.detail}` : String(e)}`);
    }
  }

  if (created.length === 0 && errors.length > 0) {
    throw new GateError(400, 'BRACKET_FAILED', errors.join(' | '));
  }
  res.json({ ok: true, created, errors, size: qty });
}));

router.delete('/price-order/:id', wrap(async (req, res) => {
  requireArm(req);
  await gatePrivate('DELETE', `/futures/usdt/price_orders/${encodeURIComponent(String(req.params.id))}`);
  res.json({ ok: true });
}));

// ---------- 回测式统计：这些位历史上被碰过几次、守住几次 ----------

router.get('/level-stats', wrap(async (req, res) => {
  const contract = String(req.query.contract ?? 'BTC_USDT');
  const interval = INTERVALS.has(String(req.query.interval)) ? String(req.query.interval) : '15m';
  const price = Number(req.query.price);
  const horizon = Math.min(200, Math.max(10, Number(req.query.horizon ?? 60)));
  if (!Number.isFinite(price)) throw new GateError(400, 'BAD_INPUT', '缺少 price');
  const bars = (await loadCandles(contract, interval, 1000)).slice(0, -1);
  const atrV = detectLevels(bars).atr;
  const tol = Math.max(0.45 * atrV, price * 0.0015);

  let touched = 0; let held = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const inZone = b.low - tol <= price && b.high + tol >= price;
    if (!inZone) continue;
    touched++;
    const window = bars.slice(i, i + horizon);
    const brokeUp = window.some((x) => x.close > price + tol * 2);
    const brokeDown = window.some((x) => x.close < price - tol * 2);
    if (!(brokeUp && brokeDown) && (brokeUp || brokeDown)) held++;
  }
  res.json({
    price,
    tolerance: tol,
    touched,
    held,
    holdRate: touched ? Math.round((held / touched) * 1000) / 1000 : null,
    sampleBars: bars.length,
  });
}));

interface GateTicker {
  contract: string; last: string; mark_price: string; change_percentage: string;
  volume_24h_quote: string; funding_rate: string; quanto_multiplier: string; total_size: string;
}

router.get('/tickers', wrap(async (_req, res) => {
  const list = await gatePublic<GateTicker[]>('/futures/usdt/tickers');
  const rows = list
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
    }));
  res.json(rows.sort((a, b) => b.volume24hUsd - a.volume24hUsd));
}));

export type { Direction };
