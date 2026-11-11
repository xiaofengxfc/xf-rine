/**
 * 结构状态：市场现在是在往上走、往下走，还是横向晃。
 *
 * 和 levels.ts 一样只看已收盘的 K 线：摆动点要求左右各 k 根都在数据里才确认，
 * 所以任何一根 bar 在生成自己的结论时都不会用到它后面的数据（no-lookahead）。
 * 这一点比「多认几种形态」重要得多 —— 用了未来数据的结构判断，回测好看、实盘不灵。
 *
 * 认的东西：
 *   HH / HL（更高的高点、更高的低点）→ 上升
 *   LH / LL（更低的高点、更低的低点）→ 下降
 *   两边都不成立 → 区间
 *   BOS（break of structure）：顺着当前方向破掉最近的摆动极值
 *   CHoCH（change of character）：第一次朝反方向破掉关键摆动点，通常意味着这一段走完了
 *   区间位置：现价在最近一段摆动区间里的百分比（0 = 区间底、100 = 区间顶）
 *
 * 术语借的是 ICT / Smart Money Concepts 那一套（BOS、CHoCH、premium / discount），
 * 但代码是一行行自己写的：那几个项目全是 Pine Script 或 Python，没有能直接搬进 TS 的成品，
 * 而且 TradingView 上的同类指标普遍用未收盘 K 线确认结构（repaint），照抄会把那个毛病带进来。
 */

import { pivots, type Bar } from './levels.js';

export type TrendState = 'up' | 'down' | 'range';
export type StructureEventKind = 'BOS' | 'CHoCH';
export type Zone = 'premium' | 'equilibrium' | 'discount';

export interface StructureEvent {
  kind: StructureEventKind;
  direction: 'up' | 'down';
  /** 被破掉的那个摆动点的价位 */
  price: number;
  /** 那次摆动点在 bars 里的序号 */
  index: number;
  time: number;
}

export interface StructureAnalysis {
  trend: TrendState;
  /** 最近一个确认的高点 / 低点 */
  lastHigh: { price: number; index: number } | null;
  lastLow: { price: number; index: number } | null;
  event: StructureEvent | null;
  /** 现价在最近摆动区间里的位置，0-100；区间太窄或点数不够时是 null */
  rangePct: number | null;
  zone: Zone | null;
  /** 一句话结论，带数字，直接能显示 */
  note: string;
}

export interface StructureOptions {
  /** 摆动点窗口，和 levels 保持一致（默认 3） */
  swing?: number;
}

const pctText = (v: number) => v.toFixed(0) + '%';

export function analyzeStructure(bars: Bar[], opts: StructureOptions = {}): StructureAnalysis {
  const swing = opts.swing ?? 3;
  const empty: StructureAnalysis = {
    trend: 'range', lastHigh: null, lastLow: null, event: null,
    rangePct: null, zone: null, note: 'K 线太少，还看不出结构',
  };
  const clean = bars.filter((b) => Number.isFinite(b.close) && b.high >= b.low);
  // 摆动点要左右各 k 根，少于 2k+3 根连一个点都确认不了
  if (clean.length < swing * 2 + 3) return empty;

  const pts = pivots(clean, swing);
  const highs = pts.filter((p) => p.kind === 'high');
  const lows = pts.filter((p) => p.kind === 'low');
  const last = clean[clean.length - 1]!;
  const close = last.close;
  const lastHigh = highs.length > 0 ? highs[highs.length - 1]! : null;
  const lastLow = lows.length > 0 ? lows[lows.length - 1]! : null;
  if (!lastHigh || !lastLow) return { ...empty, lastHigh: lastHigh && { price: lastHigh.price, index: lastHigh.index }, lastLow: lastLow && { price: lastLow.price, index: lastLow.index } };

  // 趋势：最近两个高点、两个低点的相对关系。缺一个就只能算区间
  const prevHigh = highs.length > 1 ? highs[highs.length - 2]! : null;
  const prevLow = lows.length > 1 ? lows[lows.length - 2]! : null;
  let trend: TrendState = 'range';
  if (prevHigh && prevLow) {
    const higher = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
    const lower = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;
    trend = higher ? 'up' : lower ? 'down' : 'range';
  }

  // 结构事件：收盘越过最近的摆动极值才算破。顺着趋势破是 BOS，逆着破是 CHoCH
  let event: StructureEvent | null = null;
  if (close > lastHigh.price) {
    event = {
      kind: trend === 'down' ? 'CHoCH' : 'BOS',
      direction: 'up',
      price: lastHigh.price,
      index: lastHigh.index,
      time: lastHigh.time,
    };
  } else if (close < lastLow.price) {
    event = {
      kind: trend === 'up' ? 'CHoCH' : 'BOS',
      direction: 'down',
      price: lastLow.price,
      index: lastLow.index,
      time: lastLow.time,
    };
  }

  // 区间位置：最近一个高点和一个低点围出来的那一格。区间窄到没有意义就别说折价溢价
  const span = lastHigh.price - lastLow.price;
  const rangePct = span > 0 && Number.isFinite(span)
    ? Math.max(0, Math.min(100, ((close - lastLow.price) / span) * 100))
    : null;
  const zone: Zone | null = rangePct === null
    ? null
    : rangePct >= 66 ? 'premium' : rangePct <= 34 ? 'discount' : 'equilibrium';

  const trendText = trend === 'up' ? '上升' : trend === 'down' ? '下降' : '区间';
  const trendWhy = trend === 'up'
    ? '更高的高点 + 更高的低点'
    : trend === 'down' ? '更低的高点 + 更低的低点' : '高点和低点没有同向';
  const zoneText = zone === null ? '' : '，现价在最近区间 ' + pctText(rangePct!)
    + '（' + (zone === 'premium' ? '溢价区，追多要小心' : zone === 'discount' ? '折价区，追空要小心' : '中间位置') + '）';
  const eventText = event === null
    ? ''
    : '；最近一次 ' + event.kind + ' ' + (event.direction === 'up' ? '向上破' : '向下破') + ' ' + event.price;

  return {
    trend,
    lastHigh: { price: lastHigh.price, index: lastHigh.index },
    lastLow: { price: lastLow.price, index: lastLow.index },
    event,
    rangePct: rangePct === null ? null : Math.round(rangePct * 10) / 10,
    zone,
    note: trendText + '结构（' + trendWhy + '）' + zoneText + eventText,
  };
}
