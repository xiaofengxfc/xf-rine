import { apiUrl, authHeaders } from './endpoint.ts';

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
    throw new ApiError(b?.error ?? `HTTP_${res.status}`, b?.detail ?? text.slice(0, 300), res.status);
  }
  return body as T;
}

export function jget<T>(url: string, init?: RequestInit): Promise<T> {
  // 口令和地址都在这里补：调用方写的一律是 /api/xxx，手机端才会拼到电脑上
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() };
  // 兜一个超时：没有它，一个卡住的请求会让面板一直停在上一帧，看着像「数据不动了」
  const signal = init?.signal ?? AbortSignal.timeout(20_000);
  return fetch(apiUrl(url), { ...init, signal, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } })
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
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface Level {
  /** 区中枢 */
  price: number;
  zoneLow: number;
  zoneHigh: number;
  role: 'support' | 'resistance';
  /** 排序分（触及次数 + 陈旧度）。是相对强度，不是概率，别当守住的可能性读 */
  score: number;
  /** 历史上触及后守住的比例（Wilson 下界，0-1）。样本不足时给 0.25 */
  holdRate: number;
  /** 触及事件数 / 其中守住几次 */
  touches: number;
  holds: number;
  /** 越久没被碰过越强（0-1） */
  stale: number;
  /** 「价格容易在这里停」的倾向，不参与排序 */
  pStall: number;
  /** 区宽 / ATR */
  widthAtr: number;
  /** 距现价（%，带符号，负=在下方） */
  distancePct: number;
  /** 距现价 / ATR */
  distAtr: number;
  /** 最近一次触及距今多少根 bar，从没碰过是 -1 */
  barsSinceTouch: number;
  /**
   * 排序分落在历史分位的第几档（1-5）。
   *
   * 这是上游在 A 股日线上标定出来的分档线，只能说明「这个分在本样本里属于高档还是低档」，
   * 不是胜率，也不是「守住概率」。界面上必须按这个口径写。
   */
  bucket?: number;
}

/** 本地数据目录里的一个品种，以及它有哪些周期 */
export interface LocalInstrument {
  symbol: string;
  /** 文件名里的周期代号，如 D1 / H1 / 15min —— 原样带回去查 K 线 */
  timeframes: string[];
}

export interface LocalDirInfo {
  dir: string;
  instruments: LocalInstrument[];
  /** 这个目录里认得的数据文件数 */
  files: number;
  /** 记住的目录还在不在。被挪走、被删掉时是 false，界面要直说而不是空着 */
  exists: boolean;
  error?: string;
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
  levels: Level[];
  atr: number;
  last: number;
  rangeHigh: number;
  rangeLow: number;
  nearestSupport: Level | null;
  nearestResistance: Level | null;
  /** 回看的 bar 数，以及用到的已确认枢轴数（自查用） */
  lookback: number;
  pivots: number;
}

export interface Position {
  contract: string; size: number; direction: 'long' | 'short'; leverage: number;
  entryPrice: number; markPrice: number; liqPrice: number; unrealisedPnl: number;
  value: number; mode: string;
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
  account: Account;
  positions: Position[];
  orders: OpenOrder[];
  priceOrders: PriceOrder[];
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
  env: 'testnet' | 'live';
  envLabel: string;
  restBaseUrl: string;
  keys: { configured: boolean; hint: string };
  keysByEnv: Record<'testnet' | 'live', { configured: boolean; hint: string }>;
  liveTrading: boolean;
  ai: AiSettings;
  /** 密钥文件的实际路径。装在桌面上时不在 server/.env，设置页要说对地方 */
  envPath?: string;
  /** 手机端要填的地址和口令。口令只在本机打开页面时才有值 */
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
  time: number; open: number; high: number; low: number; close: number; volume: number; closed: boolean;
}

/** 服务端 /ws 推下来的东西 */
export type WsMessage =
  | { type: 'candle'; contract: string; bar: LiveBar }
  | ({ type: 'ticker' } & LiveTicker)
  | { type: 'trade'; contract: string; price: number; size: number; ts: number }
  | { type: 'hello'; ts: number }
  | { type: 'subscribed'; contract: string; interval: string }
  | { type: 'gate_down' };
