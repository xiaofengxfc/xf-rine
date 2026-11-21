import type { WebSocketServer } from 'ws';

/**
 * 一家交易所。
 *
 * 为什么要有这一层：这个台子的交易链路（下单、平仓、反手、挂保护单、
 * 清理孤儿触发单）写了四千多行，全是按 Gate 的接口和口径推出来的。再加一家时
 * 有两条路：把那些逻辑复制一份，或者让两家都说同一种话。
 *
 * 这里选后者 —— 下面这些字段名仍然是 Gate 那一套（contract / quanto_multiplier /
 * unfinished 的 left 之类），**Bitget 的适配器负责把它的数据翻成这个样子**。
 * 换来的是 routes.ts 里的交易逻辑一条都不用重写：那套逻辑讲的是「张、多空边、
 * 触发单」，本来就跟具体交易所无关。
 *
 * 两条口径必须一致，否则账会算错：
 *   1. **张**：1 张 = quanto_multiplier 个币。Gate 本来就是这样；Bitget 的下单接口
 *      收的是币数量，适配器用 sizeMultiplier 换算，所以页面上写的「张」在两家是同一个意思。
 *   2. **方向**：size 带符号，正数多、负数空。单向持仓模式下由持仓方向决定符号；
 *      双向持仓模式靠 mode 里的 dual_long / dual_short。
 */

export type ExchangeId = 'gate' | 'bitget';
export type XEnv = 'testnet' | 'live';

/** 合约元数据。字段名就是 Gate 那套，routes 里按这些名字取值 */
export interface XContract {
  name: string;
  /** 1 张 = 多少个币 */
  quanto_multiplier: string;
  /** 最小下单张数 */
  order_size_min: number;
  /** 下单张数步进；整数量为 1，小数合约按交易所精度设置 */
  size_step?: number;
  order_size_max: number;
  enable_decimal?: boolean;
  /**
   * 下单数量的币数量精度（小数位）。
   * Gate 原生张数不使用；Bitget 的下单接口收的是币数量，必须按它的位数写：
   * 多写一位会被拒，少写一位会冒出 0.00030000000000000003 这种尾巴。
   */
  size_place?: number;
  /** 最小变动价 */
  order_price_round: string;
  mark_price_round: string;
  leverage_min: string;
  leverage_max: string;
  last_price: string;
  mark_price: string;
  funding_rate: string;
  funding_rate_indicative: string;
  /** 资金费结算间隔，小时 */
  funding_interval: number;
  in_delisting: boolean;
  status: string;
  position_size: number;
  taker_fee_rate: string;
  maker_fee_rate: string;
  /** 限价单允许偏离现价的比例，0.05 = 5% */
  order_price_deviate: string;
}

/** 一条持仓。size 带符号（空头为负），单向模式下方向就靠这个符号 */
export interface XPosition {
  contract: string;
  size: string;
  /** single / dual_long / dual_short */
  mode: string;
  leverage: string;
  /** Margin mode reported by exchanges that expose it (crossed / isolated). */
  margin_mode?: string;
  entry_price: string;
  mark_price: string;
  liq_price: string;
  unrealised_pnl: string;
  realised_pnl: string;
  value: string;
}

/** 一张挂着的委托 */
export interface XOrder {
  id: string;
  contract: string;
  /** 带符号张数：正是买，负是卖 */
  size: string;
  /** 还剩多少张没成交 */
  left: string;
  price: string;
  fill_price: string;
  /** open / finished */
  status: string;
  /** 成交完是什么：filled / cancelled */
  finish_as: string;
  /** Gate 下单回执里还带这一个字段，routes 的 AI 执行器读它；Bitget 那边留空 */
  fill_as?: string;
  is_reduce_only: boolean;
  /** unix 秒 */
  create_time: number;
  tif: string;
}

/**
 * 一张触发单（到价平仓的保护单）。
 *
 * 形状也照着 Gate 的 price_orders：initial 是「到价之后下什么单」，
 * trigger 是「什么条件算到价」。routes 的 readTriggers 只认这几个字段。
 */
export interface XTrigger {
  id: string;
  /** UTA TP/SL displays as separate rows but is cancelled as one strategy order. */
  cancel_id?: string;
  initial: {
    contract: string;
    size: number;
    price: string;
    tif: string;
    reduce_only: boolean;
    close: boolean;
    auto_size?: 'close_long' | 'close_short';
  };
  trigger: {
    strategy: number;
    price_type: number;
    price: string;
    /** 1 = 价格 >= 触发价，2 = 价格 <= 触发价 */
    rule: number;
    /** 有效期秒数，0 = 不过期 */
    expiration: number;
  };
  create_time: number;
}

/** 账户权益 */
export interface XAccount {
  total: number;
  available: number;
  unrealised_pnl: number;
  currency: string;
}

/** 全市场一行行情 */
export interface XTicker {
  contract: string;
  last: string;
  mark_price: string;
  /** 24 小时涨跌幅，单位是「百分数」（2.5 表示 2.5%） */
  change_percentage: string;
  volume_24h_quote: string;
  funding_rate: string;
  quanto_multiplier: string;
  /** 未平仓张数 */
  total_size: string;
}

/** 一根 K 线。t 是秒 */
export interface XCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: number;
  sum?: string;
}

/**
 * 下单参数。
 *
 * 还是 Gate 那套：size 带符号、price 为 '0' 表示市价、auto_size 表示整边平仓。
 * 适配器负责翻成自己那边的写法 —— 这一层翻译正是「加一家交易所」要用到的全部东西。
 */
export interface XOrderSpec {
  contract: string;
  size: number;
  price: string;
  tif: string;
  reduce_only: boolean;
  close?: boolean;
  auto_size?: 'close_long' | 'close_short';
}

/** 挂一张触发单（止损 / 止盈） */
export interface XTriggerSpec {
  initial: {
    contract: string;
    size: number;
    price: string;
    tif: string;
    reduce_only: boolean;
    close: boolean;
    auto_size?: 'close_long' | 'close_short';
  };
  trigger: {
    strategy: number;
    price_type: number;
    price: string;
    rule: number;
    expiration: number;
  };
}

/** 行情连接。客户端协议（candle / ticker / trade / gate_down）两家完全一样 */
export interface MarketHub {
  connect(): void;
  status(): { alive: boolean; subscriptions: number; clients: number };
  close(): void;
}

export interface Exchange {
  readonly id: ExchangeId;
  /** 报错和页面上显示的交易所名 */
  readonly label: string;
  /** 这个交易所支持的 K 线周期（页面只列这些） */
  readonly intervals: string[];
  /** 账户和交易打哪个地址 */
  restBase(): string;
  /** 公共行情打哪个地址 */
  publicBase(): string;
  keysConfigured(): boolean;
  requireKeys(): void;
  /** 密钥尾号，设置页显示用 */
  keyHint(): { configured: boolean; hint: string };
  keyHintFor(env: XEnv): { configured: boolean; hint: string };

  /** 整张合约表（用于最小变动价、乘数），很慢，调用方自己缓存 */
  contracts(timeoutMs?: number, attemptMs?: number): Promise<XContract[]>;
  /** 单个合约，参数取「下单环境」那台机器（测试网和实盘的位数可能不同） */
  tradeContract(name: string): Promise<XContract>;
  /** 单个合约，公共行情那条路 */
  publicContract(name: string): Promise<XContract>;
  /** 一页 K 线。to 是秒，且不含 to 那一根之前的处理由调用方做 */
  candles(name: string, interval: string, limit: number, to?: number): Promise<XCandle[]>;
  /** 全市场行情 */
  tickers(timeoutMs?: number, attemptMs?: number): Promise<XTicker[]>;
  /** 当前环境能交易的合约名。null = 不做限制 */
  tradableNames(): Promise<Set<string> | null>;

  account(): Promise<XAccount>;
  /** Gross realized trading PnL for [fromMs, toMs), excluding fees and funding. */
  dailyRealisedPnl(fromMs: number, toMs: number): Promise<number>;
  positions(contract?: string): Promise<XPosition[]>;
  openOrders(contract?: string): Promise<XOrder[]>;
  order(id: string): Promise<XOrder | null>;
  placeOrder(spec: XOrderSpec): Promise<XOrder>;
  cancelOrder(id: string): Promise<void>;
  triggers(): Promise<XTrigger[]>;
  placeTrigger(spec: XTriggerSpec): Promise<XTrigger>;
  cancelTrigger(id: string): Promise<void>;
  /** 设杠杆，顺手把保证金模式定下来（模式只能从这个口子设） */
  setLeverage(name: string, opts: { lev: number; cross: boolean }): Promise<{
    leverage: number;
    crossLeverageLimit: number;
    mode: 'cross' | 'isolated';
  }>;

  marketHub(wss: WebSocketServer): MarketHub;
}
