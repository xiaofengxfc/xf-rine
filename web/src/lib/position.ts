import type { Position } from './api.ts';

/**
 * 一张合约的乘数（每张多少币）。
 * 服务端会按当前下单环境带回来；没有就用手上还剩的两个数反推：
 * 持仓价值 = 张数 × 乘数 × 标记价。
 */
export function multiplierOf(p: Position, fallback = 0): number {
  if (fallback > 0) return fallback;
  if (p.multiplier && p.multiplier > 0) return p.multiplier;
  const n = Math.abs(p.size);
  if (n > 0 && p.markPrice > 0 && p.value > 0) return p.value / (n * p.markPrice);
  return 0;
}

/**
 * 从「成本 / 张数 / 乘数 / 方向」直接算到某个价位平掉的盈亏（USDT）。
 *
 * 全站只有这一个盈亏公式：持仓卡、图上摘要、保护单预览都走它。
 * 多空用同一个式子，空头取负 —— 和交易所的 unrealised_pnl 一分不差。
 * 乘数或张数读不出来时返回 0，不编一个看起来合理的数。
 */
export function pnlFromCost(
  side: 'long' | 'short',
  entry: number,
  size: number,
  multiplier: number,
  price: number,
): number {
  if (!(entry > 0) || !(size > 0) || !(multiplier > 0) || !(price > 0)) return 0;
  return (price - entry) * size * multiplier * (side === 'short' ? -1 : 1);
}

export interface PnlView {
  /** 已盈亏，USDT */
  pnl: number;
  /** 占占用保证金的百分比（ROE）。乘数读不到时为 null */
  pct: number | null;
  /** 算这个数用的价格 */
  price: number;
}

/**
 * 持仓的已盈亏。
 *
 * 多空用同一个式子：(标记价 - 开仓价) × 张数 × 乘数，空头取负。
 * 这就是交易所 unrealised_pnl 的口径 —— 在模拟盘上多空各开 1 张实测过，
 * 两边算出来和接口返回的一分不差。所以多单和空单的盈亏一定对得上，
 * 也不会出现「多头按涨算、空头也按涨算」这种方向错误。
 *
 * 传进来的 price 一般是 ws 推上来的标记价：交易所按标记价算盈亏，
 * 拿最新成交价来算会和交易所差几个点，看着就像数据对不上。
 */
export function pnlOf(p: Position, price = p.markPrice, fallbackMult = 0): PnlView {
  const mult = multiplierOf(p, fallbackMult);
  const at = price > 0 ? price : p.markPrice;
  const size = Math.abs(p.size);
  if (mult > 0 && at > 0 && p.entryPrice > 0 && size > 0) {
    const pnl = pnlFromCost(p.direction === 'short' ? 'short' : 'long', p.entryPrice, size, mult, at);
    const margin = p.leverage > 0 ? (p.entryPrice * size * mult) / p.leverage : 0;
    return { pnl, pct: margin > 0 ? (pnl / margin) * 100 : null, price: at };
  }
  // 乘数读不到就退回交易所给的数，不自己编一个
  return { pnl: p.unrealisedPnl, pct: null, price: at };
}

/** 到某个价位平掉这张仓，已经实现多少盈亏。图上标止损止盈时用 */
export function pnlAt(p: Position, price: number): number {
  return pnlOf(p, price).pnl;
}
