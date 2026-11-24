/**
 * 一个市场能干哪些事。
 *
 * 这个项目长期把「USDT 永续」当成唯一形态，于是这些假设散落在各处：
 * 能开空（永续能）、能加杠杆（永续能）、有强平价（永续有）、能挂触发单（永续能）、
 * 有资金费、24 小时不停。要加现货、交割、期权或者股票时，这些假设会一个接一个地
 * 在各处冒出来 —— 而且每处都只露一点，很难一次找全。
 *
 * 所以把它们收成一张表：UI 一律从能力读，而不是从「我知道这是永续」读。
 *
 * 这张表只描述市场类型本身，不描述某个合约的参数（杠杆上限、最小变动价仍在合约元数据里）。
 */

export interface MarketCapabilities {
  /** 能做空（现货一般不能，除非有融券） */
  canShort: boolean;
  /** 有杠杆和保证金模式（逐仓/全仓） */
  hasLeverage: boolean;
  /** 有资金费结算 */
  hasFunding: boolean;
  /** 合约会到期（交割合约有，永续没有） */
  hasExpiry: boolean;
  /** 能用触发单挂止损止盈（现货一般用普通条件单，语义不同） */
  hasTriggerOrders: boolean;
  /** 有「持仓」这个概念（现货买了就是余额，不是一笔仓） */
  hasPositions: boolean;
  /** 有强平价（逐仓+杠杆才有意义） */
  hasLiquidation: boolean;
  /** 交易时段受日历约束（股票有，加密永续没有） */
  hasSession: boolean;
  /** 数量的单位：张 / 基础币 / 股 */
  sizeUnit: 'contract' | 'base' | 'share';
  /** 页面上一句话说明这是什么市场 */
  label: string;
}

/**
 * USDT 永续：当前唯一真实存在的形态。
 *
 * 这张表就是「现在的行为」，逐条对着代码能验：能开空、能加杠杆、有资金费、
 * 不过期、能挂触发单、有持仓、有强平价、24 小时不停、按张下单。
 */
export const PERP_CAPABILITIES: MarketCapabilities = {
  canShort: true,
  hasLeverage: true,
  hasFunding: true,
  hasExpiry: false,
  hasTriggerOrders: true,
  hasPositions: true,
  hasLiquidation: true,
  hasSession: false,
  sizeUnit: 'contract',
  label: '永续合约',
};

/**
 * 现货。**K 线已经接了（Gate REST，只读）；交易还没接。**
 *
 * 定这张表是为了让「现货不能开空、没有杠杆、没有持仓」这几件事有个准确的说法，
 * 而不是让 UI 继续按永续的假设去画。
 *
 * 接的是 REST 而不是 WebSocket：现货 WS 频道（spot.candlesticks）的帧里不带货币对名，
 * 要按订阅时的 payload 反查，那个映射没法离线验证。REST 是数组格式、结构稳定，
 * 先用它把现货 K 线接上；WS 增量以后再说。
 *
 * 交易（下单、加杠杆、挂止损止盈）仍然只认永续：那几个接口只读 contract 参数，
 * 现货身份进不去，所以这里 hasPositions / hasLeverage 为 false 与代码是一致的。
 */
export const SPOT_CAPABILITIES: MarketCapabilities = {
  canShort: false,
  hasLeverage: false,
  hasFunding: false,
  hasExpiry: false,
  hasTriggerOrders: false,
  hasPositions: false,
  hasLiquidation: false,
  hasSession: false,
  sizeUnit: 'base',
  label: '现货',
};

const TABLE: Record<string, MarketCapabilities> = {
  perp: PERP_CAPABILITIES,
  spot: SPOT_CAPABILITIES,
};

/** 已经真的接了数据源的市场。UI 据此区分「不支持」和「还没接」 */
export const WIRED_MARKETS: readonly string[] = ['perp'];

/**
 * 按市场类型取能力表。
 *
 * 认不出的市场返回 null，**不返回一个「什么都不能」的空表**：空表会让页面
 * 显示一堆「这个市场不支持」，而真正的问题是前端认识了一个后端还不支持的市场。
 * 调用方据此退回默认行为。
 */
export function capabilitiesFor(market: string): MarketCapabilities | null {
  return TABLE[market] ?? null;
}
