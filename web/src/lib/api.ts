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

export function jget<T>(url: string): Promise<T> {
  return fetch(url, { headers: { Accept: 'application/json' } }).then(parse<T>);
}

export function jsend<T>(
  method: 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  token?: string,
  /** 用来中途取消（AI 分析点「停止」时用） */
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-arm-token'] = token;
  return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal }).then(parse<T>);
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
  price: number;
  role: 'support' | 'resistance';
  strength: number;
  touches: number;
  failures: number;
  volumeRatio: number;
  distancePct: number;
  lastTouch: number;
  zoneLow: number;
  zoneHigh: number;
}

export interface Bracket {
  direction: 'long' | 'short';
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  stopSource: string;
  targetSource: string;
  stopDistancePct: number;
  targetDistancePct: number;
  riskPct: number;
  acceptable: boolean;
  minRR: number;
}

export interface LevelsResponse {
  contract: string;
  interval: string;
  barsUsed: number;
  levels: Level[];
  atr: number;
  last: number;
  rangeHigh: number;
  rangeLow: number;
  nearestSupport: Level | null;
  nearestResistance: Level | null;
  brackets: { long: Bracket | null; short: Bracket | null };
  patterns: Pattern[];
}

export interface Position {
  contract: string; size: number; direction: 'long' | 'short'; leverage: number;
  entryPrice: number; markPrice: number; liqPrice: number; unrealisedPnl: number;
  value: number; mode: string;
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

export interface Pattern {
  kind: string;
  name: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  time: number;
  index: number;
  strength: number;
  note: string;
}

export interface LiveBar {
  time: number; open: number; high: number; low: number; close: number; volume: number; closed: boolean;
}
