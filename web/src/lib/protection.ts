/**
 * 止损止盈的填写检查。
 *
 * 只有一种来源：用户自己填的两个价。这里做三件事 —— 判方向、判现价有没有跑过去、
 * 把「离入场价多远」折算成百分比。不替用户编价格，空着的就是这一边不挂。
 *
 * 判断要连标记价一起看：触发单看的是最新成交价，而标记价常常比它更靠里，
 * 止损正好落在这两个价之间时，只按最新价判会放过它，挂上去那一秒就成交。
 */

/** 摘要里一行「止损 / 止盈」：price 为 0 时显示 note */
export interface ProtectRow {
  label: string;
  price: number;
  pct: number | null;
  note?: string;
}

/** 两个价直接落到下单参数上。0 表示这一边不挂 */
export function protectionPrices(manualStop: number, manualTarget: number): { stop: number; target: number } {
  return { stop: Math.max(0, manualStop), target: Math.max(0, manualTarget) };
}

/** 价格跑到错误一侧了没有。多头的止损要在下方、止盈要在上方，空头反过来 */
export function wrongSide(
  side: 'long' | 'short',
  stop: number,
  target: number,
  refPrice: number,
  markPrice = 0,
): { stop: boolean; target: boolean } {
  if (!(refPrice > 0)) return { stop: false, target: false };
  const low = markPrice > 0 ? Math.min(refPrice, markPrice) : refPrice;
  const high = markPrice > 0 ? Math.max(refPrice, markPrice) : refPrice;
  return {
    stop: stop > 0 && (side === 'long' ? stop >= low : stop <= high),
    target: target > 0 && (side === 'long' ? target <= high : target >= low),
  };
}

/** 摘要只列填了的那些：空着写「不挂」，方向反了写「方向不对」 */
export function protectionRows(
  side: 'long' | 'short',
  manualStop: number,
  manualTarget: number,
  refPrice: number,
  markPrice = 0,
): ProtectRow[] {
  if (manualStop <= 0 && manualTarget <= 0) return [];
  // 手动填的价没有预计算的百分比，按入场价现算，好看出离得远不远
  const fromPrice = (p: number) => (refPrice > 0 && p > 0 ? ((p - refPrice) / refPrice) * 100 : null);
  const wrong = wrongSide(side, manualStop, manualTarget, refPrice, markPrice);
  return [
    {
      label: '止损',
      price: manualStop,
      pct: fromPrice(manualStop),
      note: wrong.stop ? '方向不对，挂上就成交' : '不挂',
    },
    {
      label: '止盈',
      price: manualTarget,
      pct: fromPrice(manualTarget),
      note: wrong.target ? '方向不对，挂上就成交' : '不挂',
    },
  ];
}
