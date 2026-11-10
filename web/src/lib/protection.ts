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
export function planWrongSide(
  side: 'long' | 'short',
  plan: Bracket | null,
  refPrice: number,
): { stop: boolean; target: boolean } {
  if (!plan || !(refPrice > 0)) return { stop: false, target: false };
  return {
    stop: side === 'long' ? plan.stop >= refPrice : plan.stop <= refPrice,
    target: side === 'long' ? plan.target <= refPrice : plan.target >= refPrice,
  };
}
