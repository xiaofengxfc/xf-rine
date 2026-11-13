/**
 * 关键位时间线：把引擎算的支撑阻力变成回测和实盘都能用的序列。
 *
 * 为什么需要「时间线」而不是直接调一次：
 * 引擎算的是「给定一段 K 线，现在的关键位在哪」。回测要的是「第 i 根时，当时能看到的关键位」，
 * 所以只能滚动着算 —— 每 N 根调一次引擎，算出来的结果给接下来那 N 根用。
 * 这样第 i 根用到的位，只依赖 i 之前的数据，不碰未来。
 *
 * 代价：9000 根、每 50 根算一次 = 180 次引擎调用。热态一次约 70ms，合计十几秒。
 * 这个时间花在建立时间线上，参数搜索时复用同一条，不会乘上候选数。
 */

import type { Candle } from './backtest.js';

export interface ZonePoint {
  center: number;
  low: number;
  high: number;
  type: 'support' | 'resistance';
  /** 触达概率（0~1），引擎给的原始值 */
  pTouch: number | null;
  /** 守住概率（0~1） */
  pHold: number | null;
  edge: number;
}

export interface ZoneSlice {
  fromIndex: number;
  toIndex: number;
  zones: ZonePoint[];
}

export interface ZoneTimeline {
  slices: ZoneSlice[];
  every: number;
}

export const EMPTY_TIMELINE: ZoneTimeline = { slices: [], every: 0 };

/** 从引擎的 zone 对象里取我们关心的几个字段 */
export function toZonePoint(z: {
  center: number; low: number; high: number; zone_type: 'support' | 'resistance';
  p_touch: number | null; p_hold: number | null; edge_score: number;
}): ZonePoint {
  return {
    center: Number(z.center),
    low: Number(z.low),
    high: Number(z.high),
    type: z.zone_type,
    pTouch: z.p_touch,
    pHold: z.p_hold,
    edge: Number(z.edge_score) || 0,
  };
}

/**
 * 找出离 price 最近的支撑和阻力。
 *
 * 「最近」统一按中心价比较，不用带宽的边界 —— 引擎给的带宽度是证据面的半高宽，
 * 拿带宽边缘去比，一条宽带会把离得很远的中心价说成「就在脚下」。
 */
export function nearestZone(zones: ZonePoint[], price: number): {
  support: ZonePoint | null;
  resistance: ZonePoint | null;
} {
  let support: ZonePoint | null = null;
  let resistance: ZonePoint | null = null;
  for (const z of zones) {
    if (z.type === 'support' && z.center <= price) {
      if (!support || z.center > support.center) support = z;
    } else if (z.type === 'resistance' && z.center >= price) {
      if (!resistance || z.center < resistance.center) resistance = z;
    }
  }
  return { support, resistance };
}

/** 第 i 根落在哪个切片上 */
export function sliceAt(timeline: ZoneTimeline, i: number): ZoneSlice | null {
  if (timeline.slices.length === 0) return null;
  // 切片是连续的，二分比线性扫快；几千根、几百片时差别不大，但便宜就做了
  let lo = 0;
  let hi = timeline.slices.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = timeline.slices[mid]!;
    if (i < s.fromIndex) hi = mid - 1;
    else if (i > s.toIndex) lo = mid + 1;
    else return s;
  }
  return null;
}

/**
 * 滚动构建时间线。
 *
 * `analyze` 由调用方注入（真实环境里是 sidecar，自检里是假的），
 * 这样这一层不依赖网络，能单独测。
 */
export async function buildZoneTimeline(
  candles: Candle[],
  every: number,
  warmup: number,
  analyze: (window: Candle[]) => Promise<ZonePoint[]>,
  lookback = 300,
): Promise<ZoneTimeline> {
  const step = Math.max(1, Math.floor(every));
  const slices: ZoneSlice[] = [];
  for (let i = Math.max(warmup, 1); i < candles.length; i += step) {
    // 只喂 i 及之前的 K 线：这一段是「当时能看到的全部」，喂多了就是未来函数
    const from = Math.max(0, i - lookback + 1);
    const window = candles.slice(from, i + 1);
    let zones: ZonePoint[] = [];
    try {
      zones = await analyze(window);
    } catch {
      // 引擎一次失败不该让整条时间线报废：这一片空着，回测里「没有关键位」是可处理的状态
      zones = [];
    }
    slices.push({ fromIndex: i, toIndex: Math.min(candles.length - 1, i + step - 1), zones });
  }
  return { slices, every: step };
}

/** 按 K 线时间建一张「这一根上有哪些关键位」的表。提示词策略按根取用 */
export function zonesByTime(timeline: ZoneTimeline, candles: Candle[]): Map<number, ZonePoint[]> {
  const table = new Map<number, ZonePoint[]>();
  for (const s of timeline.slices) {
    for (let i = s.fromIndex; i <= s.toIndex && i < candles.length; i++) {
      table.set(candles[i]!.t, s.zones);
    }
  }
  return table;
}

/**
 * 把时间线翻成两条能直接给回测用的序列：最近支撑价、最近阻力价。
 *
 * 没有关键位时给 NaN —— 指标层遇到 NaN 一律返回 false，
 * 于是「这一根没有可用的位」自然变成「这个条件不成立」，不需要特判。
 */
export function zoneSeries(
  timeline: ZoneTimeline,
  candles: Candle[],
): {
  support: (i: number, candle: Candle) => number;
  resistance: (i: number, candle: Candle) => number;
} {
  // 按「K 线时间」建表，而不是按数组下标：参数搜索会把同一份 K 线切成三段，
  // 段内下标和原始下标对不上，按下标取值会整体错位
  const table = new Map<number, { sup: number; res: number }>();
  for (const s of timeline.slices) {
    for (let i = s.fromIndex; i <= s.toIndex && i < candles.length; i++) {
      const c = candles[i]!;
      const n = nearestZone(s.zones, c.c);
      table.set(c.t, {
        sup: n.support ? n.support.center : NaN,
        res: n.resistance ? n.resistance.center : NaN,
      });
    }
  }
  return {
    support: (_i, candle) => table.get(candle.t)?.sup ?? NaN,
    resistance: (_i, candle) => table.get(candle.t)?.res ?? NaN,
  };
}
