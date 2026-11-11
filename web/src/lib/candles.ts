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
  /** 再并就超过本地上限。到上限就不再补，已经画上去的一根都不动 */
  full: boolean;
}

/**
 * 把一页更早的 K 线并到前面。
 *
 * 超上限时宁可不并 —— 先加再 slice(-max) 会把最老的那几百根挤掉，
 * 用户正看着左边，那一片会当场变空，看起来就是 K 线缺了一段。
 */
export function mergeOlder(prev: Bar[], older: Bar[], maxBars: number): OlderMerge {
  if (older.length === 0) return { bars: prev, added: 0, duplicate: true, full: false };
  const seen = new Set(prev.map((b) => b.time));
  const add = older.filter((b) => !seen.has(b.time));
  if (add.length === 0) return { bars: prev, added: 0, duplicate: true, full: false };
  if (prev.length + add.length > maxBars) return { bars: prev, added: 0, duplicate: false, full: true };
  const merged = [...add, ...prev];
  merged.sort((a, b) => a.time - b.time);
  return { bars: normalizeBars(merged), added: add.length, duplicate: false, full: false };
}
