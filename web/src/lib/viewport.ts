/**
 * 视口：把「刚才在看的那一段时间」换算回逻辑区间。
 *
 * 单独拎出来是因为这里有两个容易写错、写错了又很像「图自己抽了一下」的地方：
 *
 *   - 视口按时间恢复，不按下标：左侧补历史后逻辑序号会整体变化。
 *   - 右侧 margin 由调用方传入，避免把视口恢复和图表默认留白绑死。
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
  /** 整个可视区在最新 K 线之后时，按最新 K 线计算的逻辑坐标 */
  futureFrom?: number;
  futureTo?: number;
  /** 可视区超出最早 K 线左侧时，相对时间锚点的逻辑位置 */
  pastFrom?: number;
  pastTo?: number;
}

export interface LogicalRange {
  from: number;
  to: number;
}

/** 少于一屏的两根说明那一段已经不在手上了，放回去只会把画面扔到别处 */
const MIN_BARS = 2;

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
  if (Number.isFinite(span.futureFrom) && Number.isFinite(span.futureTo)) {
    const from = bars.length - 1 + span.futureFrom!;
    const to = bars.length - 1 + span.futureTo!;
    if (from <= to && to - from >= Math.max(MIN_BARS, minBars)) return { from, to };
  }
  const from = firstIndexAtOrAfter(bars, span.fromTime);
  if (Number.isFinite(span.pastFrom) && Number.isFinite(span.pastTo)) {
    const pastFrom = from + span.pastFrom!;
    const pastTo = from + span.pastTo!;
    if (pastFrom <= pastTo && pastTo - pastFrom >= Math.max(MIN_BARS, minBars)) {
      return { from: pastFrom, to: pastTo };
    }
  }
  const to = firstIndexAtOrAfter(bars, span.toTime);
  if (to - from < Math.max(MIN_BARS, minBars)) return null;
  // 右边那一根就是最后一根（或者落在它之后）时，把右侧空位原样留着
  const atEdge = to >= bars.length - 1;
  // 不限制正向空位：视口可能是用户主动拖到很远的未来区。
  const margin = Number.isFinite(span.margin) ? Math.max(0, Math.round(span.margin)) : 0;
  return { from, to: atEdge ? bars.length - 1 + margin : to };
}
