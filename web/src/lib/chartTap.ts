/**
 * 点按命中：手指点下去，落在哪一根 K 线上。
 *
 * 单独拎出来是因为这里有一件容易写错、写错了又看不出来的事：**吸附**。
 * 手机上 15m 图一根只有 4~8px，手指却按下去 40px 宽。照手指的 x 直接换算，
 * 十次里有几次会落到相邻那根上 —— 读数卡片上的数字于是跟手指点的地方差一根。
 * 这里按「吸附半径内取最近」处理：半径里没有 K 线就返回 null，
 * 让调用方自己决定是「点空白处」还是「什么都不做」。
 *
 * 纵向不参与判断：箭头画在 K 线下方，但它只是这一根的标记 ——
 * 点在 K 线身上和点在箭头上要读到的是同一根，分两套窗口只会让「点K线」点不出东西。
 *
 * 纯函数：不碰 DOM、不碰图表，脚本里能直接钉住几种真实形状（见 scripts/check-chart-tap.ts）。
 */

export interface TapBars {
  /** K 线的秒级时间，按下标升序 */
  time: number[];
}

export interface TapGeometry {
  /** 时间轴：第 index 根在画布上的 x 坐标（CSS 像素）。单调递增 */
  indexToX: (index: number) => number | null;
  /** 一共排了多少根（含右侧空白）。手指落在最后一根右边时用它收口 */
  count: number;
}

export interface TapOptions {
  /**
   * 横向吸附半径，单位是「根」。
   *
   * 0.75 根：手指偏四分之三根还算最近那根，再偏就是下一根了 ——
   * 既不会漏点（半个间距就够），也不会把点空白处也算成点中（拖到未来区不用点）。
   */
  snapX?: number;
  /** 一屏最密时一根也不到这个宽度：吸附半径按它算，否则两排挤在一起点不准 */
  minSpacing?: number;
}

/** 默认值：和 ChartPane 里的箭头尺寸对得上，别各写各的 */
export const TAP_DEFAULTS = {
  snapX: 0.75,
  minSpacing: 8,
} as const;

/** 一次点按落在哪个位置 */
export interface TapHit {
  /** 命中哪一根（bars 里的下标） */
  index: number;
  /** 这一根的时间 */
  time: number;
  /** 手指离这一根中心偏了多少像素（正数表示手指在右边） */
  dx: number;
}

/**
 * 手指点在画布的 x，算落在哪一根。
 *
 * 距离按「离这一根中心的像素」算，不按每根各自一段区间 —— 区间是离散的，
 * 落在两个区间的缝上会谁也不中；距离是连续的，取最小值永远有个结果，
 * 再用 snapX 卡住「太远就不算」。
 */
export function hitTestTap(
  x: number,
  bars: TapBars,
  geo: TapGeometry,
  opts: TapOptions = {},
): TapHit | null {
  const count = Math.min(bars.time.length, geo.count);
  if (count <= 0 || !Number.isFinite(x)) return null;

  const snap = opts.snapX ?? TAP_DEFAULTS.snapX;
  const minSpacing = opts.minSpacing ?? TAP_DEFAULTS.minSpacing;

  /**
   * 二分：时间轴的 x 随下标单调递增，最近的一根只可能在 x 左右两侧那两根里。
   * 不逐根算坐标，是因为一屏可能排着近两万根，一次点按要换算两万次没有必要。
   */
  const nearest = nearestIndex(x, count, geo.indexToX);
  if (nearest === null) return null;

  let best: { index: number; dx: number; distance: number } | null = null;
  /**
   * 二分给的是「第一个 x 不小于手指」的那一根，最近的可能在它左右两侧；
   * 间距在不同缩放下不一样，所以左右各多看两根，再去掉太远的。
   */
  for (let i = Math.max(0, nearest - 2); i <= Math.min(count - 1, nearest + 2); i += 1) {
    const px = geo.indexToX(i);
    if (px === null || !Number.isFinite(px)) continue;
    const distance = Math.abs(px - x);
    if (!best || distance < best.distance) best = { index: i, dx: px - x, distance };
  }
  if (!best) return null;

  const spacing = measureSpacing(best.index, count, geo.indexToX, minSpacing);
  const unit = Math.max(minSpacing, spacing);
  if (best.distance > unit * snap) return null;

  return { index: best.index, time: bars.time[best.index] as number, dx: best.dx };
}

/** 第一个不比 x 小的下标（标准 lowerBound），读不到坐标就返回 null */
export function nearestIndex(
  x: number,
  count: number,
  indexToX: (index: number) => number | null,
): number | null {
  let lo = 0;
  let hi = count - 1;
  // 整张图都在手指右边（点在最早那根左边）
  const firstX = indexToX(0);
  if (firstX !== null && Number.isFinite(firstX) && x <= firstX) return 0;
  const lastX = indexToX(count - 1);
  if (lastX !== null && Number.isFinite(lastX) && x >= lastX) return count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const px = indexToX(mid);
    if (px === null || !Number.isFinite(px)) return null;
    if (px < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 量一下这一根附近的间距。
 *
 * 优先取左右各一根的平均：视口边缘只剩一根邻居时退回单侧，再没有就退回 minSpacing
 * （说明整屏只放得下一两根，这时候吸附半径按最小间距算更稳）。
 */
export function measureSpacing(
  index: number,
  count: number,
  indexToX: (index: number) => number | null,
  fallback: number,
): number {
  const here = indexToX(index);
  const left = index > 0 ? indexToX(index - 1) : null;
  const right = index < count - 1 ? indexToX(index + 1) : null;
  const deltas: number[] = [];
  if (here !== null && left !== null && here > left) deltas.push(here - left);
  if (here !== null && right !== null && right > here) deltas.push(right - here);
  if (deltas.length === 0) return fallback;
  return deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
}
