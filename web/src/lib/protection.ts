import type { Bracket } from './api.ts';

/**
 * 开仓前的保护方式：不设 / 用方案价 / 手动填两个价。
 * 三选一最后都要落成「止损、止盈两个价」交给 /api/order，0 表示这一边不挂。
 */
export type ProtectMode = 'none' | 'plan' | 'manual';

export function protectionPrices(
  mode: ProtectMode,
  plan: Bracket | null,
  manualStop: number,
  manualTarget: number,
): { stop: number; target: number } {
  if (mode === 'manual') return { stop: manualStop, target: manualTarget };
  if (mode === 'plan' && plan) return { stop: plan.stop, target: plan.target };
  // 没选方案，或者这个方向压根没算出方案 —— 宁可什么都不挂，也不替用户猜一个价
  return { stop: 0, target: 0 };
}

/**
 * 方案价是按方案入场价算出来的，不保证永远站在现价这一边。
 * 现价已经跑过方案止损（多头的止损在现价上方），那张触发单一挂上就成交；
 * 服务端 checkTriggerPrices 也会拒（BAD_STOP / BAD_TARGET），下单前先看这一眼。
 */
/** 摘要里一行「止损 / 止盈」：price 为 0 时显示 note */
export interface ProtectRow {
  label: string;
  price: number;
  pct: number | null;
  note?: string;
}

/**
 * 摘要只列这一单真会挂上去的保护：
 * 不设一行都不显示；手动设填了哪个显示哪个，空着的写「没有」；
 * 方案价被现价跑过的那一边不挂，写「现价已跑过，不挂」。
 */
export function protectionRows(
  mode: ProtectMode,
  side: 'long' | 'short',
  plan: Bracket | null,
  manualStop: number,
  manualTarget: number,
  refPrice: number,
  /** 标记价，和最新价一起判断跑没跑过；不传就只看最新价 */
  markPrice = 0,
): ProtectRow[] {
  if (mode === 'none') return [];
  /** 手动填的价没有预计算的百分比，按现价现算，好看出离得多远 */
  const fromPrice = (p: number) => (refPrice > 0 && p > 0 ? ((p - refPrice) / refPrice) * 100 : null);
  if (mode === 'plan') {
    if (!plan) {
      return [
        { label: '止损（方案）', price: 0, pct: null, note: '还没算出来' },
        { label: '止盈（方案）', price: 0, pct: null, note: '还没算出来' },
      ];
    }
    const wrong = planWrongSide(side, plan, refPrice, markPrice);
    return [
      wrong.stop
        ? { label: '止损（方案）', price: 0, pct: null, note: '现价已跑过，不挂' }
        : { label: '止损（方案）', price: plan.stop, pct: -plan.stopDistancePct },
      wrong.target
        ? { label: '止盈（方案）', price: 0, pct: null, note: '现价已跑过，不挂' }
        : { label: '止盈（方案）', price: plan.target, pct: plan.targetDistancePct },
    ];
  }
  return [
    { label: '止损（手动）', price: manualStop, pct: fromPrice(manualStop), note: '没有' },
    { label: '止盈（手动）', price: manualTarget, pct: fromPrice(manualTarget), note: '没有' },
  ];
}

/**
 * 方案价跑到现价另一边了没有。
 * 触发单（price_type 0）看的是最新成交价，而标记价常常比它更靠里 ——
 * 止损正好落在这两个价之间时，只按最新价判会放过它，挂上去那一秒就成交。
 * 所以两边取更严格的那个：要低于 min(最新价, 标记价)，或高于 max(最新价, 标记价)。
 */
export function planWrongSide(
  side: 'long' | 'short',
  plan: Bracket | null,
  refPrice: number,
  markPrice = 0,
): { stop: boolean; target: boolean } {
  if (!plan || !(refPrice > 0)) return { stop: false, target: false };
  const low = markPrice > 0 ? Math.min(refPrice, markPrice) : refPrice;
  const high = markPrice > 0 ? Math.max(refPrice, markPrice) : refPrice;
  return {
    stop: side === 'long' ? plan.stop >= low : plan.stop <= high,
    target: side === 'long' ? plan.target <= high : plan.target >= low,
  };
}
