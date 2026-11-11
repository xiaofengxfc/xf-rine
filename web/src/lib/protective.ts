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

/** 「5 小时 12 分」这种粗粒度时长。保护单到期的精度是小时级，不需要秒 */
export function fmtLeft(ms: number): string {
  if (ms <= 0) return '已过期';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest > 0 ? h + ' 小时 ' + rest + ' 分' : h + ' 小时';
  return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
}

export interface ProtectionState {
  /** 这一边有没有挂着的保护单（止损或止盈） */
  armed: boolean;
  /** 止损止盈一张都没有 —— 裸仓 */
  naked: boolean;
  /** 最近的那张什么时候到期，unix 秒；0 = 没有到期时刻或读不出来 */
  expiresAt: number;
  /** 距到期还剩多久，给页面直接显示；没有到期时刻是空串 */
  left: string;
  /** 到期在 15 分钟以内（或者已经过了）：要显眼提醒，来不及再等 */
  urgent: boolean;
}

/**
 * 这一边的保护还剩多久。
 *
 * Gate 的触发单带 expiration（秒），到点交易所自己把单撤掉（见服务端的 PROTECT_EXPIRATION_SEC）。
 * 以前这一项根本没读回来，于是隔夜之后仓就裸着，页面上只写「止损未设」——
 * 看着像自己忘了设，其实是交易所撤的。现在把剩余时间摆到脸上。
 */
export function protectionState(b: SideBracket, now = Date.now()): ProtectionState {
  const has = [b.stop, b.target].filter((o): o is PriceOrder => Boolean(o));
  const expiries = has.map((o) => o.expiresAt ?? 0).filter((t) => t > 0);
  const expiresAt = expiries.length > 0 ? Math.min(...expiries) : 0;
  const ms = expiresAt > 0 ? expiresAt * 1000 - now : 0;
  return {
    armed: has.length > 0,
    naked: has.length === 0,
    expiresAt,
    left: expiresAt > 0 ? fmtLeft(ms) : '',
    urgent: expiresAt > 0 && ms <= 15 * 60_000,
  };
}

export function bracketOf(priceOrders: PriceOrder[], contract: string, dir: Dir): SideBracket {
  const rows = priceOrders.filter((o) => o.contract === contract && o.direction === dir);
  return {
    stop: rows.find((o) => triggerKind(o, dir) === 'stop') ?? null,
    target: rows.find((o) => triggerKind(o, dir) === 'target') ?? null,
  };
}
