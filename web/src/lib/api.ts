import { apiUrl, authHeaders } from './endpoint.ts';

/**
 * 解锁令牌失效的通知。
 *
 * 令牌在服务端内存里，服务重启或者在别处锁定过之后就没了 ——
 * 页面自己看不出来，仍写着「交易已解锁」。任何一个需要解锁的请求被 NOT_ARMED
 * 拒掉时，这里立刻通知界面落锁，别让人对着一个假的已解锁状态反复点。
 */
let notArmedHandler: (() => void) | null = null;

export function setNotArmedHandler(fn: (() => void) | null): void {
  notArmedHandler = fn;
}

export class ApiError extends Error {
  label: string;
  status: number;
  constructor(label: string, detail: string, status: number) {
    super(detail || label);
    this.label = label;
    this.status = status;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const b = body as { error?: string; detail?: string } | null;
    if (res.status === 403 && b?.error === 'NOT_ARMED') notArmedHandler?.();
    throw new ApiError(b?.error ?? `HTTP_${res.status}`, b?.detail ?? text.slice(0, 300), res.status);
  }
  return body as T;
}

export function jget<T>(url: string, init?: RequestInit): Promise<T> {
  // 口令和地址都在这里补：调用方写的一律是 /api/xxx，手机端才会拼到电脑上
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() };
  // 兜一个超时：没有它，一个卡住的请求会让面板一直停在上一帧，看着像「数据不动了」
  const signal = init?.signal ?? AbortSignal.timeout(20_000);
  return fetch(apiUrl(url), {
    ...init,
    cache: 'no-store',
    signal,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
    .then(parse<T>);
}

export function jsend<T>(
  method: 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  token?: string,
  /** 用来中途取消（AI 分析点「停止」时用） */
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-arm-token'] = token;
  // 写接口的超时给得宽：服务端自己可能已经超时重试过两轮。这里只是别让按钮永远转下去；
  // 真超时的时候服务端那边会给一句「不确定有没有受理」，页面照它说的去核对
  const ctl = signal ?? AbortSignal.timeout(45_000);
  return fetch(apiUrl(url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl }).then(parse<T>);
}

// ---------- 类型 ----------

export interface ContractInfo {
  name: string;
  multiplier: number;
  sizeMin: number;
  /** 下单张数步进（接口未返回时由最小量回退推算） */
  sizeStep?: number;
  sizeMax: number;
  priceRound: number;
  leverageMin?: number;
  leverageMax: number;
  price: number;
  markPrice: number;
  fundingRate: number;
  fundingInterval: number;
  takerFee: number;
  makerFee: number;
  orderPriceDeviate?: number;
  status?: string;
  /** 当前环境能不能交易它 */
  tradable?: boolean;
}

export interface Ticker {
  contract: string;
  last: number;
  mark: number;
  change24h: number;
  volume24hUsd: number;
  fundingRate: number;
  /** 这个合约的最小变动价。持仓卡里同时显示别的合约，价格得按各自的最小变动位写 */
  priceRound?: number;
  /** 当前环境能不能交易它。模拟盘只上架了几十个合约，其余只能看 */
  tradable?: boolean;
}

export interface Bar {
  time: number; open: number; high: number; low: number; close: number; volume: number; turnover?: number;
}

/**
 * 一条支撑/阻力带。字段名就是引擎（Python sidecar）输出的名字，没做改名。
 *
 * 概率三件套的口径（引擎侧实测，界面上必须按这个说法写）：
 *   p_touch     未来若干根内价格走到这个位的概率。区分度强（AUC 0.73~0.77）
 *   p_hold      走到之后反弹而不是跌穿的概率。校准好（说 75% 实际 75.4%），
 *               但区分度弱（AUC 0.59~0.61）：绝对值能看，别拿它比较相邻两个位
 *   p_effective 两者相乘，批量扫描按它排序
 * bucket 是「这个位的强度落在历史第几档」，bucket_hold_rate 是那一档在样本外的实测守住率。
 */
export interface Zone {
  p_touch: number | null;
  p_hold: number | null;
  p_effective: number | null;
  /** 区中枢 / 上下沿 */
  center: number;
  low: number;
  high: number;
  zone_type: 'support' | 'resistance';
  zone_label: string;
  /** 距现价（%，带符号，负=在下方）/ ATR 倍数 / 区宽 ATR */
  distance_pct: number;
  distance_atr: number;
  width_atr: number;
  width_pct: number | null;
  /** 排序分 = log1p(触及次数) + 0.8×陈旧度。相对强度，不是概率 */
  edge_score: number;
  /** 历史被测试次数 / 陈旧度 */
  n_events: number;
  stale: number;
  /** 「价格容易在这里停」的倾向（不参与排序）及其历史分档 */
  p_stall: number;
  stall_bucket: string | null;
  vp_strength: number;
  /** 强度分档（Q1~Q5）与该档的样本外实测 */
  bucket: string | null;
  bucket_hold_rate: number | null;
  bucket_fwd_ret: number | null;
  bucket_n: number | null;
  /**
   * 这条位是「之前出现过、这次没重算出来」的历史位。
   * 页面把它画淡一点：让人还看得见刚才那条支撑，而不是凭空消失。
   */
  history?: boolean;
  /** 这条位来自邻居周期（例如「4 小时」）。只有高周期共振位带这个字段 */
  from_tf?: string;
  /** 共振周期数（1 = 只有本周期）/ 具体是哪几个周期 */
  tf_count: number;
  tfs: string;
}

/** 方向化摘要：最近位、最强位、趋势、一句话结论、以及那段必须说清的口径说明 */
export interface AnalysisSummary {
  direction: string;
  direction_label: string;
  nearest: Zone | null;
  best: Zone | null;
  trend_label: string;
  trend_detail: string;
  headline: string;
  caveat: string;
}

export interface EngineInfo {
  atr: number;
  atr_pct: number | null;
  calibrated: boolean;
  calib_meta: Record<string, unknown>;
  prob_ready: boolean;
  prob_meta: Record<string, unknown>;
  adjust_mode?: string;
  adjust_source?: string;
  n_ex_rights?: number;
  adjust_warning?: string | null;
}

export interface MtfGroup {
  tf: string;
  tf_label: string;
  zones: Zone[];
}

/** 本地数据目录里的一个品种，以及它有哪些周期 */
export interface LocalInstrument {
  symbol: string;
  /** 文件名里的周期代号，如 D1 / H1 / 15min —— 原样带回去查 K 线 */
  timeframes: string[];
}

/**
 * 本地数据目录的状态。研究台和日内台共用这一份（/api/data/dir），
 * 目录里有哪些品种、哪些周期都来自引擎的同一张表 —— 两边各问一次必然漂。
 */
export interface LocalDirInfo {
  dir: string;
  instruments: LocalInstrument[];
  /** 这个目录里认得的数据文件数 */
  files: number;
  /** 认得的品种数（引擎报的，和 instruments.length 同源） */
  count: number;
  /** 周期代号 -> 显示名（D1 -> 日线），来自引擎的同一张表 */
  tfLabels?: Record<string, string>;
  /** 记住的目录还在不在。被挪走、被删掉时是 false，界面要直说而不是空着 */
  exists: boolean;
  /** 目录在、但引擎读不了时的说明 */
  warning?: string;
}

export interface LocalBars {
  contract: string;
  interval: string;
  source: 'local';
  bars: Bar[];
  /** 文件里一共多少根，界面据此说「给了多少 / 一共多少」 */
  total: number;
  exhausted: boolean;
  intervalSec: number;
}

export interface LevelsResponse {
  contract: string;
  interval: string;
  /** 数据来自交易所实时 K 线，还是本地那个 Parquet 目录 */
  source?: 'gate' | 'local';
  barsUsed: number;
  /** 这次算出来的位（位置已经钉住，不会随每次重算漂移） */
  zones: Zone[];
  /** 之前出现过、这次没算出来的位。画淡一点，别让它凭空消失 */
  historyZones?: Zone[];
  atr: number;
  last: number;
  nearestSupport: Zone | null;
  nearestResistance: Zone | null;
  summary: AnalysisSummary;
  engine: EngineInfo;
  mtf_zones: MtfGroup[];
}

export interface Position {
  contract: string; size: number; direction: 'long' | 'short'; leverage: number;
  entryPrice: number; markPrice: number; liqPrice: number; unrealisedPnl: number;
  value: number; mode: string;
  /** Some exchanges return the margin mode separately from leverage. */
  marginMode?: 'isolated' | 'cross';
  /** 合约乘数（每张多少币）。页面按它现算已盈亏，读不到就是 0 */
  multiplier?: number;
}

export interface OpenOrder {
  id: string; contract: string; size: number; left: number; price: number; fillPrice: number;
  status: string; reduceOnly: boolean;
  /** 下单时间，unix 秒（服务端已经统一过单位） */
  createTime: number;
  tif: string;
}

export interface PriceOrder {
  id: string; contract: string; direction: '' | 'long' | 'short';
  triggerPrice: number; triggerRule: number; size: number;
  /** 到价平仓的保护单。靠 auto_size / isclose 判定，不能看 reduce_only（Gate 回读成 false） */
  protective: boolean;
  /** 交易所原样带回来的 reduce_only */
  reduceOnly: boolean;
  /** 整边平仓（isclose），看不出平哪一边 */
  closeAll: boolean;
  /** 挂单时间，unix 秒 */
  createTime: number;
  /** 交易所会在这一刻把它撤掉（unix 秒）。0 = 读不出来或没有过期 */
  expiresAt: number;
}

/** 平仓、反手时连带撤掉的东西 */
export interface CanceledTrades {
  orders: string[];
  triggers: string[];
  errors: string[];
}

export interface CloseResult {
  ok: boolean;
  orders: { direction: 'long' | 'short'; size: number; id: string; status: string }[];
  canceled: CanceledTrades;
}

export interface Account { total: number; available: number; unrealisedPnl: number; currency: string }
export interface DailyPnl { realisedPnl: number; fromMs: number; toMs: number; currency: string }

/** 服务端出网用的代理。Node 不读系统代理，服务端自己读一次注册表 */
export interface ProxyStatus {
  on: boolean;
  url: string;
  source: 'env' | 'system' | 'direct';
  error?: string;
  /** 上一次因为 Gate 的 IP 白名单退回直连的时刻 */
  blockedAt?: number;
  at: number;
}

/** 当前 IP。Gate 的 API 密钥按 IP 白名单时填它 */
export interface IpInfo {
  ok: boolean;
  ip: string;
  country?: string;
  region?: string;
  city?: string;
  isp?: string;
  source?: string;
  at: number;
  error?: string;
  /** 只有服务端那条会带：代理状态和直连出口 */
  proxy?: ProxyStatus;
  directIp?: string;
}

/** 账户这一坨一次取回来的快照，四个字段来自同一时刻 */
export interface PrivateState {
  account?: Account;
  positions?: Position[];
  orders?: OpenOrder[];
  priceOrders?: PriceOrder[];
  errors?: Partial<Record<'account' | 'positions' | 'orders' | 'priceOrders', string>>;
  /** 这次请求带的解锁令牌在服务端还有效吗。页面每 3 秒照它落锁 */
  armed?: boolean;
}

/** 行情推送上来的那一帧：最新价、标记价、24 小时涨跌、资金费 */
export interface LiveTicker {
  contract: string;
  last: number;
  mark: number;
  change24h: number;
  fundingRate: number;
  volume24hUsd: number;
}

export interface AiSettings {
  configured: boolean;
  baseUrl: string;
  model: string;
  hint: string;
  endpoint?: string;
}

export interface AiAnalysis {
  contract: string;
  interval: string;
  verdict: 'long' | 'short' | 'wait';
  confidence: number;
  reasons: string[];
  conflicts: string[];
  riskNote: string;
  model: string;
  at: number;
  raw?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AppConfig {
  /** 当前连的交易所。合约名、张数、下单都跟着它走 */
  exchange: 'gate' | 'bitget';
  exchangeLabel: string;
  /** 这家支持的 K 线周期。Bitget 没有 8h，列出来点了只会报错 */
  intervals: string[];
  env: 'testnet' | 'live';
  envLabel: string;
  restBaseUrl: string;
  keys: { configured: boolean; hint: string };
  keysByEnv: Record<'testnet' | 'live', { configured: boolean; hint: string }>;
  liveTrading: boolean;
  ai: AiSettings;
  /** 密钥文件的实际路径。装在桌面上时不在 server/.env，设置页要说对地方 */
  envPath?: string;
  /** 远程连接电脑端所需的地址和口令，仅在该服务端本机显示 */
  remote?: { enabled: boolean; urls: string[]; token: string | null };
  /**
   * 这个请求是不是从这台电脑上发出来的（服务端按回环地址判定）。
   *
   * 「选本地数据目录」读的是硬盘，只有本机才能用。前端不能靠 window.location.hostname 猜：
   * 桌面壳和局域网地址下那个值和请求来源对不上。
   */
  local?: boolean;
  /** 反馈寄到哪。信箱内嵌在服务端，页面只显示、不给改 */
  feedback?: { to: string; from: string; ready: boolean };
}

export interface NewsItem {
  title: string; url: string; source: string; publishedAt: number;
  score: number; sentiment: number; matched: string[];
}

export interface FeedStat { name: string; ok: boolean; count: number; error?: string }

export interface NewsDigest {
  contract: string; base: string; fetchedAt: number;
  items: NewsItem[]; feeds: FeedStat[];
  sentiment: number; stance: 'bullish' | 'neutral' | 'bearish'; note: string;
}


export interface LiveBar {
  time: number; open: number; high: number; low: number; close: number; volume: number; turnover?: number; closed: boolean;
}

/** 服务端 /ws 推下来的东西 */
export type WsMessage =
  | { type: 'candle'; contract: string; bar: LiveBar }
  | ({ type: 'ticker' } & LiveTicker)
  | { type: 'trade'; contract: string; price: number; size: number; ts: number }
  | { type: 'hello'; ts: number }
  | { type: 'subscribed'; contract: string; interval: string }
  /**
   * 服务端的心跳。页面不拿它当数据，只靠它判断这条连接还活着没有 ——
   * 半开的连接不会发 close，没有这一条就只能刷新页面。
   */
  | { type: 'ping'; ts: number }
  | { type: 'gate_down' };


// ---------- 研究台（/api/research/*） ----------

/** 引擎自检。ok=false 时 detail 说明为什么没起来（没装 python / 缺依赖 / 崩了） */
export interface ResearchHealth {
  ok: boolean;
  detail?: string;
  engine?: string;
  python?: string;
  numpy?: string;
  probReady?: boolean;
  calibrated?: boolean;
  probMeta?: Record<string, unknown>;
  calibMeta?: Record<string, unknown>;
}

/** 单品种分析结果。字段与引擎输出一致，图表用 kline（列式，unix 秒） */
export interface ResearchAnalysis {
  symbol: string;
  symbol_label: string;
  tf: string;
  tf_label: string;
  current_price: number;
  change_pct: number;
  window: number;
  n_zones: number;
  data_bars: number;
  zones: Zone[];
  mtf_zones: MtfGroup[];
  summary: AnalysisSummary;
  engine: EngineInfo;
  direction: string;
  direction_label: string;
  kline?: {
    time: number[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[];
  };
  kline_total: number;
}

/** 批量扫描的一行 */
export interface ScanRow {
  symbol: string;
  tf: string;
  current_price: number;
  change_pct: number;
  n_zones: number;
  nearest_support: number | null;
  nearest_support_dist_pct: number | null;
  nearest_resistance: number | null;
  nearest_resistance_dist_pct: number | null;
  p_touch: number | null;
  p_hold: number | null;
  p_effective: number | null;
  edge_score: number | null;
  n_events: number | null;
  width_atr: number | null;
  nearest_distance_pct: number | null;
  nearest_distance_atr: number | null;
  bucket: string | null;
  p_stall: number | null;
  trend_label: string;
  direction: string;
  data_bars: number;
  atr_pct: number | null;
  adjusted: boolean;
  adjust_source: string | null;
}

export interface ResearchScan {
  summary: {
    total: number;
    analyzed: number;
    failed: number;
    n_adjusted: number;
    n_unadjusted: number;
    tf: string;
    tf_label: string;
    window: number;
    n_zones: number;
    direction: string;
    direction_label: string;
    data_dir: string;
    calibrated: boolean;
    prob_ready: boolean;
  };
  rows: ScanRow[];
  errors: { symbol: string; reason: string }[];
}

// ---------- AI 交易（/api/ai/*） ----------

/** 策略配置。字段和 server/src/aiStrategy.ts 里那份一一对应，改一边要改另一边 */
export interface AiStrategy {
  enabled: boolean;
  /** 用哪条策略。空白表示还没选，不能开 */
  strategyId: string;
  /** 由策略推导，页面只读 */
  contracts: string[];
  interval: string;
  leverage: number;
  marginMode: 'isolated' | 'cross';
  maxPositions: number;
  maxDailyLossPct: number;
  minConfidence: number;
  minRR: number;
  liveConfirmed: boolean;
  dayKey: string;
  dayStartEquity: number;
  haltReason: string;
  haltUntil: number;
}

export interface AiGateCheck { label: string; ok: boolean; detail: string }

/** 风控闸门的结论。张数、名义价值、保证金、这一笔亏多少都在这里 */
export interface AiGate {
  ok: boolean;
  action: 'long' | 'short' | 'hold';
  size: number;
  notional: number;
  margin: number;
  riskUsd: number;
  stopDistance: number;
  rr: number;
  binding: string;
  checks: AiGateCheck[];
  refusals: string[];
  warnings: string[];
}

export interface AiTurn {
  role: string;
  label: string;
  text: string;
  at: number;
  ok: boolean;
  error?: string;
}

/** 模型给的方案。注意没有张数：张数由闸门算 */
export interface AiPlan {
  action: 'long' | 'short' | 'hold';
  confidence: number;
  entry: number | null;
  entryType: 'market' | 'limit';
  stop: number | null;
  target: number | null;
  horizonHours: number;
  reasoning: string;
  reasons: string[];
  conflicts: string[];
  vetoes: string[];
  riskNote: string;
}

export interface AiExecution {
  ok: boolean;
  order?: { id: string; status: string; fillPrice: number; size: number };
  error?: string;
}

export interface AiDecisionRecord {
  id: string;
  at: number;
  env: 'testnet' | 'live';
  envLabel: string;
  contract: string;
  interval: string;
  /** 这一轮按哪类策略做的决定 */
  strategyKind: 'rule' | 'prompt';
  model: string;
  plan: AiPlan;
  gate: AiGate;
  exec: AiExecution;
  turns: AiTurn[];
  usage: { promptTokens: number; completionTokens: number; calls: number };
  ms: number;
  error?: string;
}

export interface AiRunnerStatus {
  enabled: boolean;
  running: boolean;
  busy: boolean;
  env: 'testnet' | 'live';
  envLabel: string;
  strategy: AiStrategy;
  nextTickAt: number;
  lastTickAt: number;
  lastDecisionAt: number;
  skip: string;
  dayLossPct: number;
  haltReason: string;
  haltUntil: number;
  counts: { decisions: number; orders: number; refusals: number; errors: number };
  positions: number;
  lastError: string;
}

export interface AiStrategyPayload {
  strategy: AiStrategy;
  status: AiRunnerStatus;
  /** 策略库：选择器用 */
  strategies: SavedStrategySummary[];
  /** 当前绑定那条策略的细节；没选是 null */
  binding: StrategyBinding | null;
  path: string;
  ai: { configured: boolean; baseUrl: string; model: string };
  liveTrading: boolean;
}


// ---------- 回测研究台（/api/quant/*） ----------

export interface QuantIndicator {
  id: string;
  label: string;
  params: { name: string; label: string; def: number }[];
}

export interface QuantCriteria {
  minTrades: number;
  requirePositiveExpectancy: boolean;
  maxDrawdownPct: number;
  costStressMultiple: number;
  maxDecayPct: number;
}

export interface QuantCatalog {
  indicators: QuantIndicator[];
  criteria: QuantCriteria;
  fallback: {
    thesis: string;
    side: 'long' | 'short';
    params: Record<string, number>;
    ranges: Record<string, [number, number, number]>;
    entry: QuantCondition[];
    stop: { kind: 'atr' | 'pct'; value: number };
    target: { kind: 'atr' | 'pct' | 'rr'; value: number };
    whatToValidate: string;
    origin: 'first' | 'revise';
  };
  limits: { maxRounds: number; maxBars: number };
}

export interface QuantIndicatorRef {
  name: string;
  periodKey?: string;
}

export interface QuantCondition {
  left: QuantIndicatorRef;
  op: '>' | '<' | '>=' | '<=' | 'crossUp' | 'crossDown';
  right: QuantIndicatorRef;
  rightParam?: string;
  shift?: number;
  rightShift?: number;
}

export interface QuantSpec {
  name: string;
  side: 'long' | 'short';
  params: Record<string, number>;
  ranges: Record<string, [number, number, number]>;
  entry: QuantCondition[];
  stop: { kind: 'atr' | 'pct'; value: number };
  target: { kind: 'atr' | 'pct' | 'rr'; value: number };
  maxPositions: number;
}

export interface QuantCriterionResult {
  key: string;
  label: string;
  pass: boolean;
  value: string;
  threshold: string;
  why: string;
}

export interface QuantVerdict {
  passed: boolean;
  failed: QuantCriterionResult[];
  checks: QuantCriterionResult[];
}

export interface QuantBest {
  params: Record<string, number>;
  validateExpectancyPct: number;
  validateTrades: number;
  validatePayoff: number;
  validateWinRate: number;
  validateMaxDrawdownPct: number;
  validateReturnPct: number;
  validateDecay: number;
  validateCostExpectancy: Record<string, number>;
}

export interface QuantFinalEvaluation {
  candidate: {
    blindExpectancyPct?: number;
    blindTrades?: number;
    blindPayoff?: number;
    blindWinRate?: number;
    blindMaxDrawdownPct?: number;
    blindReturnPct?: number;
    costExpectancy?: Record<string, number>;
    decay?: number;
  };
  validationVerdict: QuantVerdict;
  verdict: QuantVerdict;
}

export interface QuantResearchReport {
  finalEvaluation: QuantFinalEvaluation | null;
}

export interface QuantRound {
  round: number;
  semanticIssues: { code: string; message: string }[] | null;
  candidates: number;
  enoughSample: number;
  best: QuantBest | null;
  verdictStage: 'validation';
  verdict: QuantVerdict | null;
}

/** 研究流里的每一条事件 */
export type QuantEvent =
  | { type: 'stage'; stage: string; message: string }
  | { type: 'data'; bars: number; days: number; gaps: number; from: number; to: number }
  | { type: 'hypothesis'; round: number; thesis: string; entry: { left: string; op: string; right: string; shift: number }[]; params: Record<string, number> }
  | ({ type: 'round' } & QuantRound)
  /** saved：达标的方案已经自动存进策略库，页面可以直接载入编辑器 */
  | { type: 'done'; verdict: string; report: QuantResearchReport; saved?: { id: string; name: string; spec: QuantSpec } | null }
  | { type: 'note'; message: string }
  | { type: 'error'; message: string }
  | { type: 'backtest-progress'; stage: string; message: string; done?: number; total?: number }
  | { type: 'backtest-result'; result: QuantBacktestResult }
  | { type: 'backtest-error'; message: string };

export interface QuantTradeRow {
  side: string; entryTime: number; exitTime: number;
  entryPrice: number; exitPrice: number; net: number; reason: string;
}

export interface QuantBacktestResult {
  mode: 'single' | 'search' | 'prompt';
  evaluationSegment?: 'blind';
  bars: number;
  days: number;
  gaps: number;
  stats?: {
    trades: number; wins: number; losses: number; winRate: number; payoff: number;
    expectancy: number; expectancyPct: number; totalReturnPct: number;
    maxDrawdownPct: number; profitFactor: number; maxLosingStreak: number;
    totalFee: number; totalFunding: number;
  };
  equity?: { t: number; v: number }[];
  trades?: QuantTradeRow[];
  candidates?: number;
  enoughSample?: number;
  best?: QuantBest | null;
  verdict: QuantVerdict | null;
  /** 提示词策略这一轮的可信度指标 */
  promptRun?: { calls: number; flatFallbacks: number; leaks: number; step: number };
  /** 随机基线：模型没超过它就不算数 */
  baseline?: { returnPct: number; trades: number };
}

export type StrategyKind = 'rule' | 'prompt';

export interface SavedStrategySummary {
  id: string;
  name: string;
  /** rule = 指标条件；prompt = 一段给模型的指令 */
  kind: StrategyKind;
  contract: string;
  interval: string;
  /** 规则策略才有 */
  spec: QuantSpec | null;
  /** 提示词策略才有 */
  prompt: string | null;
  /** 这条策略的风险参数：单笔风险、保证金上限、止损下限 */
  risk: { riskPct: number; maxMarginPct: number; stopAtrMult: number };
  createdAt: number;
  updatedAt: number;
  lastRun: {
    at: number;
    /** 这次回测是在哪个合约上跑的 —— 和现在要跑的合约不一致时要提示重跑 */
    contract: string;
    interval: string;
    passed: boolean;
    failed: string[];
    expectancyPct: number;
    trades: number;
    payoff: number;
    maxDrawdownPct: number;
    enoughSample: boolean;
  } | null;
}

/** AI 交易绑定的策略：合约池由它决定，不是手填的 */
export interface StrategyBinding {
  id: string;
  name: string;
  contract: string;
  interval: string;
  /** 规则策略由条件算方向；提示词策略问一次模型 */
  kind?: StrategyKind;
  passed: boolean | null;
  failed: string[];
  enoughSample: boolean;
}
