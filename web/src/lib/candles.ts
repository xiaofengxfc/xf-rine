/**
 * K 线的整理和拼接。
 *
 * 单独拎出来是因为这两件事都不该写错：
 *   - 交给 lightweight-charts 的必须是时间严格递增、没有重复的数组，乱序会直接抛异常
 *   - 往前补历史时如果把最老的那些挤掉，图上左边那一片就空了，看着就是「K 线缺了」
 * 这几个函数都是纯的，可以直接拿真实数据测。
 */
import type { Bar } from './api.ts';

/**
 * 时间严格递增、同一时间只留最后一根。
 * 已经是这个形状就原样返回 —— 每来一根实时 K 线都要走一遍，别每次都拷一份两万根的数组。
 */
export function normalizeBars(bars: Bar[]): Bar[] {
  let ok = true;
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i]!.time <= bars[i - 1]!.time) { ok = false; break; }
  }
  if (ok) return bars;
  const out: Bar[] = [];
  for (const b of [...bars].sort((x, y) => x.time - y.time)) {
    const prev = out[out.length - 1];
    if (prev && prev.time === b.time) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}

/** 第一个 time >= t 的下标（数组按时间升序）。二分，图上一万根也不怕 */
export function firstIndexAtOrAfter(bars: Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface OlderMerge {
  bars: Bar[];
  /** 真并进来的根数。调用方要显示进度或者判有没有进展就看它 */
  added: number;
  /**
   * 这一页一根新的都没有：上游的窗口没往前走。
   * 这不是到头，调用方当成「没有进展」处理就行。把它当成到头，历史就停在原地了。
   */
  duplicate: boolean;
  /** 本页剩余历史超过容量，已补入能容纳的部分 */
  full: boolean;
}

/**
 * 把一页更早的 K 线并到前面。
 *
 * 剩余容量不足时只补入离现有数据最近的部分，已显示的 K 线一根不裁，
 * 免得用户正看着左边，那一片会当场变空，看起来就是 K 线缺了一段。
 */
export function mergeOlder(prev: Bar[], older: Bar[], maxBars: number): OlderMerge {
  if (older.length === 0) return { bars: prev, added: 0, duplicate: true, full: false };
  const seen = new Set(prev.map((b) => b.time));
  const add: Bar[] = [];
  for (const bar of normalizeBars(older)) {
    if (seen.has(bar.time)) continue;
    seen.add(bar.time);
    add.push(bar);
  }
  if (add.length === 0) return { bars: prev, added: 0, duplicate: true, full: false };
  const room = maxBars - prev.length;
  if (room <= 0) return { bars: prev, added: 0, duplicate: false, full: true };
  const accepted = add.length > room ? add.slice(add.length - room) : add;
  const merged = [...accepted, ...prev];
  merged.sort((a, b) => a.time - b.time);
  return {
    bars: normalizeBars(merged),
    added: accepted.length,
    duplicate: false,
    full: accepted.length < add.length,
  };
}

/** 每个周期一根 K 线多少秒。判断「最新一根落后了几根」要用它 */
export const INTERVAL_SEC: Record<string, number> = {
  '10s': 10, '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '4h': 14400, '8h': 28800, '1d': 86400, '7d': 604800,
};

/**
 * 本地数据目录里的周期代号（D1 / H1 / M15…）。
 *
 * 那是文件名里带的那一套写法，和交易所的 1d / 1h / 15m 是两套词。
 * 只查 INTERVAL_SEC 的话，日线会退到默认的 60 秒 —— 尾部看门狗于是永远认为
 * 「最后一根落后了三个周期」，每 15 秒去要一次行情；换根判断也跟着错。
 */
const LOCAL_SEC: Record<string, number> = {
  M1: 60, M3: 180, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H2: 7200, H4: 14400, H6: 21600, H8: 28800, H12: 43200,
  D1: 86400, W1: 604800,
};

/** 一根 K 线多少秒。两套写法都认，认不出来才退回 60 */
export function intervalSeconds(tf: string): number {
  return INTERVAL_SEC[tf] ?? INTERVAL_SEC[tf.toLowerCase()] ?? LOCAL_SEC[tf.toUpperCase()] ?? 60;
}

/**
 * 平价 K 线：最高就等于最低。
 *
 * 没有任何成交的那段时间，交易所补的是一根 open=high=low=close、量为 0 的占位 K 线。
 * 这种 K 线没有实体也没有影线，一整段画出来是一排断续的小方块 ——
 * 冷门币看着就像「K 线连不上」，可数据一根没少，是那段时间真的没人成交。
 */
export function isFlatBar(b: Bar): boolean {
  return !(b.high > b.low);
}

/** 平价而且没有成交：这段确实没人交易过 */
export function isNoTradeBar(b: Bar): boolean {
  return b.volume === 0 && isFlatBar(b) && !(b.close > b.open);
}

export interface PaintedBar extends Bar {
  /** 原始数据是平价线，画之前已经被撑开过 */
  flat: boolean;
}

export interface PaintedBarsCache {
  bars: Bar[];
  tick: number;
  painted: PaintedBar[];
}

/**
 * 画图前把平价 K 线撑开。
 *
 * 撑的是影线（high/low），开、收、量一个数都不动：图上多出来的那半跳只为了
 * 让这一根能画出来，而不是「图上缺了一块」。形态、档位、盈亏这些要算数的，
 * 一律用原始数据，不许过这个函数。
 */
export function paintBars(bars: Bar[], tick: number): PaintedBar[] {
  const out: PaintedBar[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i]!;
    if (!isFlatBar(b)) { out[i] = { ...b, flat: false }; continue; }
    // 没拿到最小变动价时按万分之几撑开：只影响像素，不参与任何计算
    const half = (tick > 0 ? tick : Math.max(Math.abs(b.close) * 2e-4, 1e-9)) / 2;
    out[i] = { ...b, high: b.close + half, low: b.close - half, flat: true };
  }
  return out;
}

/** Reuse converted bars outside the changed range in already normalized data. */
export function paintBarsIncrementally(
  bars: Bar[],
  tick: number,
  previous: PaintedBarsCache,
): PaintedBar[] {
  if (previous.tick !== tick || previous.painted.length !== previous.bars.length) {
    return paintBars(bars, tick);
  }
  if (previous.bars === bars) return previous.painted;

  const sharedLimit = Math.min(previous.bars.length, bars.length);
  let prefix = 0;
  while (prefix < sharedLimit && previous.bars[prefix] === bars[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < sharedLimit - prefix
    && previous.bars[previous.bars.length - suffix - 1] === bars[bars.length - suffix - 1]
  ) {
    suffix += 1;
  }

  if (prefix === 0 && suffix === 0) {
    const offset = bars.length > 0 ? previous.bars.indexOf(bars[0]!) : -1;
    let overlap = 0;
    while (
      offset >= 0
      && offset + overlap < previous.bars.length
      && overlap < bars.length
      && previous.bars[offset + overlap] === bars[overlap]
    ) {
      overlap += 1;
    }
    if (overlap === 0) return paintBars(bars, tick);

    return [
      ...previous.painted.slice(offset, offset + overlap),
      ...paintBars(bars.slice(overlap), tick),
    ];
  }

  const changedEnd = bars.length - suffix;
  const changed = paintBars(bars.slice(prefix, changedEnd), tick);
  return [
    ...previous.painted.slice(0, prefix),
    ...changed,
    ...previous.painted.slice(previous.painted.length - suffix),
  ];
}

export interface TailMerge {
  bars: Bar[];
  /** 补进来的新根数（中间漏掉的那些） */
  added: number;
  /** 同一时间被新数据覆盖的根数（最后一根还在走，每次都会命中） */
  patched: number;
}

/**
 * 把一页「更新的」K 线并到右边界上。
 *
 * mergeOlder 管左边（历史），这个管右边（断线、丢帧之后补课）：同一时间以新的一页为准，
 * 本地原有的一根都不丢 —— 断了几分钟不该顺手把更早的尾巴剪掉。
 */
export function mergeNewer(prev: Bar[], page: Bar[], maxBars: number): TailMerge {
  if (page.length === 0) return { bars: prev, added: 0, patched: 0 };
  const byTime = new Map<number, Bar>();
  for (const b of prev) byTime.set(b.time, b);
  let added = 0;
  let patched = 0;
  for (const b of normalizeBars(page)) {
    const old = byTime.get(b.time);
    if (old) {
      if (old.open !== b.open || old.high !== b.high || old.low !== b.low
        || old.close !== b.close || old.volume !== b.volume) patched += 1;
    } else {
      added += 1;
    }
    byTime.set(b.time, b);
  }
  if (added === 0 && patched === 0) return { bars: prev, added: 0, patched: 0 };
  const merged = [...byTime.values()].sort((x, y) => x.time - y.time);
  const bars = merged.length > maxBars ? merged.slice(merged.length - maxBars) : merged;
  return { bars, added, patched };
}

export interface SparseStats {
  count: number;
  /** 平价 K 线（画不出实体）的根数 */
  flat: number;
  /** 平价且零成交的根数 */
  noTrade: number;
  /** 平价占比 0..1 */
  flatShare: number;
}

/** 一段 K 线里有多少根是平价 / 无成交。图上的提示和体检脚本都用这一份口径 */
export function sparseStats(bars: Bar[]): SparseStats {
  let flat = 0;
  let noTrade = 0;
  for (const b of bars) {
    if (isFlatBar(b)) flat += 1;
    if (isNoTradeBar(b)) noTrade += 1;
  }
  return {
    count: bars.length,
    flat,
    noTrade,
    flatShare: bars.length > 0 ? flat / bars.length : 0,
  };
}

