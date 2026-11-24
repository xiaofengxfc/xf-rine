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

const TABLE: Record<string, MarketCapabilities> = {
  perp: PERP_CAPABILITIES,
};

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
