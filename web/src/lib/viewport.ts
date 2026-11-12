/**
 * 视口：把「刚才在看的那一段时间」换算回逻辑区间。
 *
 * 单独拎出来是因为这里有两个容易写错、写错了又很像「图自己抽了一下」的地方：
 *
 *   - 停在最新一屏时，右边界之外还有几根空位（timeScale 的 rightOffset，默认 6 根）。
 *     getVisibleRange() 会把右边界夹在最后一根 K 线上，照它换算等于把空位吃掉 ——
 *     每补一页历史，画面就往左挪几根。
 *   - 补历史是往数组前面插，所有下标一起往后挪。所以窗口只能按时间找回来，
 *     记下标的做法换个根数就全对不上了。
 */
import type { Bar } from './api.ts';
import { firstIndexAtOrAfter } from './candles.ts';

export interface ViewSpan {
  /** 视口左边那一根 K 线的时间（秒） */
  fromTime: number;
  /** 视口右边那一根 K 线的时间（秒） */
  toTime: number;
  /** 右边界之外还留几根空位。停在新一屏时就是 rightOffset */
  margin: number;
}

export interface LogicalRange {
  from: number;
  to: number;
}

/** 少于一屏的两根说明那一段已经不在手上了，放回去只会把画面扔到别处 */
const MIN_BARS = 2;
/** 右侧空位最多留这么多根。超过就是记录坏了，不是用户要的 */
const MAX_MARGIN = 1000;

/**
 * 按时间把一段视口换算成新的逻辑区间。
 *
 * 换算不出来（那段时间已经不在数据里了）就返回 null，调用方保持现状 ——
 * 这时候随便挑一个位置，比什么都不做更糟。
 *
 * minBars 是「这段窗口至少放得下几根才算数」：恢复上次看到的视口时用得着，
 * 一两根宽的窗口恢复出来和没有一样。
 */
export function viewportRange(bars: Bar[], span: ViewSpan, minBars = MIN_BARS): LogicalRange | null {
  if (bars.length === 0) return null;
  const from = firstIndexAtOrAfter(bars, span.fromTime);
  const to = firstIndexAtOrAfter(bars, span.toTime);
  if (to - from < Math.max(MIN_BARS, minBars)) return null;
  // 右边那一根就是最后一根（或者落在它之后）时，把右侧空位原样留着
  const atEdge = to >= bars.length - 1;
  // 上限挡的是写坏的记录：margin 可能是几个月前的旧版本写进去的怪数，
  // 原样用会把画面甩到最后一根之后很远的一片空白里
  const margin = Math.min(MAX_MARGIN, Math.max(0, Math.round(span.margin)));
  return { from, to: atEdge ? bars.length - 1 + margin : to };
}
