import type { PriceOrder } from './api.ts';

export type Dir = 'long' | 'short';

export const dirLabel = (d: Dir): string => (d === 'long' ? '多' : '空');

/**
 * 一张触发单是止损还是止盈。
 * Gate 的 rule 只看价格走向：1 = 价格 >= 触发价，2 = 价格 <= 触发价。
 * 所以对多头 rule 1 是止盈、rule 2 是止损，对空头正好反过来。
 */
export function triggerKind(o: PriceOrder, dir: Dir): 'stop' | 'target' {
  const up = o.triggerRule === 1;
  if (dir === 'long') return up ? 'target' : 'stop';
  return up ? 'stop' : 'target';
}

/** 这一边挂着的止损、止盈各一张（挂的时候是覆盖语义，所以最多各一张） */
export interface SideBracket {
  stop: PriceOrder | null;
  target: PriceOrder | null;
}

export function bracketOf(priceOrders: PriceOrder[], contract: string, dir: Dir): SideBracket {
  const rows = priceOrders.filter((o) => o.contract === contract && o.direction === dir);
  return {
    stop: rows.find((o) => triggerKind(o, dir) === 'stop') ?? null,
    target: rows.find((o) => triggerKind(o, dir) === 'target') ?? null,
  };
}
