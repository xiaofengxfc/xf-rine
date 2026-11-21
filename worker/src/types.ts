/** 页面认的形状。名字和服务端 web/src/lib/api.ts 里的接口一一对应，别改名 */
export type ExchangeId = 'gate' | 'bitget';
export type Env = 'testnet' | 'live';
export type Direction = 'long' | 'short';

export interface ContractInfo {
  name: string;
  multiplier: number;
  sizeMin: number;
  sizeStep: number;
  sizeMax: number;
  /** Bitget 下单接口以币为单位时允许的小数位数 */
  sizePlace?: number;
  priceRound: number;
  leverageMin?: number;
  leverageMax: number;
  price: number;
  markPrice: number;
  fundingRate: number;
  fundingInterval: number;
  takerFee: number;
  makerFee: number;
  status?: string;
  tradable?: boolean;
}

export interface TickerRow {
  contract: string;
  last: number;
  mark: number;
  change24h: number;
  volume24hUsd: number;
  fundingRate: number;
  priceRound?: number;
  tradable?: boolean;
}

export interface Bar {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface Account { total: number; available: number; unrealisedPnl: number; currency: string }

export interface Position {
  contract: string; size: number; direction: Direction; leverage: number;
  entryPrice: number; markPrice: number; liqPrice: number; unrealisedPnl: number;
  value: number; mode: string; marginMode?: 'isolated' | 'cross'; multiplier?: number;
}

export interface OpenOrder {
  id: string; contract: string; size: number; left: number; price: number; fillPrice: number;
  status: string; reduceOnly: boolean; createTime: number; tif: string;
}

export interface PriceOrder {
  id: string; contract: string; direction: '' | Direction;
  triggerPrice: number; triggerRule: number; size: number;
  protective: boolean; reduceOnly: boolean; closeAll: boolean;
  createTime: number; expiresAt: number;
}

/** 下单参数。size 一律是「张数」—— 折成币的那一步在各自的客户端里做 */
export interface OrderInput {
  contract: string;
  size: number;
  side: Direction;
  /** 0 = 市价（具体走市价还是限价看 tif 和 price） */
  price: number;
  tif: 'gtc' | 'ioc';
  reduceOnly?: boolean;
}

export interface TriggerInput {
  contract: string;
  direction: Direction;
  role: 'stop' | 'target';
  price: number;
}

export interface Client {
  readonly id: ExchangeId;
  readonly label: string;
  readonly intervals: string[];
  readonly restBaseUrl: string;
  contracts(): Promise<ContractInfo[]>;
  tickers(): Promise<TickerRow[]>;
  candles(name: string, interval: string, limit: number, to?: number): Promise<Bar[]>;
  account(): Promise<Account>;
  positions(): Promise<Position[]>;
  orders(): Promise<OpenOrder[]>;
  triggers(): Promise<PriceOrder[]>;
  placeOrder(o: OrderInput): Promise<{ id: string; status: string; fillPrice: number }>;
  amendOrder(id: string, o: { price?: number; size?: number }): Promise<{ id: string }>;
  cancelOrder(id: string): Promise<{ id: string }>;
  placeTrigger(t: TriggerInput): Promise<{ id: string }>;
  cancelTrigger(id: string): Promise<{ id: string }>;
  setLeverage(name: string, leverage: number, mode: 'isolated' | 'cross'): Promise<void>;
  /** 市价平掉这一边的一定量（张）。返回交易所的委托号 */
  marketClose(name: string, direction: Direction, size: number): Promise<{ id: string; status: string }>;
}
