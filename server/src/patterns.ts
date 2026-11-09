/**
 * K 线形态识别。
 *
 * 只认几种结构最清楚的：锤子线 / 上吊线 / 射击之星 / 看涨吞没 / 看跌吞没 / 十字星。
 * 形态本身不是信号，它只说明这一根 K 线里多空谁更用力，要配合位置（支撑阻力）和
 * 趋势方向才有意义，所以每条结论都写清楚它出现在什么背景下。
 *
 * 和 levels.ts 一样只看已经走完的 K 线，不用未来数据。
 */

import type { Bar } from './levels.js';

export type PatternKind =
  | 'hammer' | 'hanging-man' | 'shooting-star' | 'inverted-hammer'
  | 'bullish-engulfing' | 'bearish-engulfing' | 'doji';

export interface Pattern {
  kind: PatternKind;
  /** 中文名，图上直接显示这个 */
  name: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  time: number;
  index: number;
  /** 0-100，粗粒度强弱，只用来排序和区分主次 */
  strength: number;
  /** 一句话说明，带具体数字，便于核对 */
  note: string;
}

interface Shape {
  range: number;
  body: number;
  upper: number;
  lower: number;
  bull: boolean;
}

function shapeOf(b: Bar): Shape {
  const range = b.high - b.low;
  return {
    range,
    body: Math.abs(b.close - b.open),
    upper: b.high - Math.max(b.close, b.open),
    lower: Math.min(b.close, b.open) - b.low,
    bull: b.close >= b.open,
  };
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

/**
 * 逐根滚动 ATR：第 i 个值只用 bars[0..i]，不碰后面的数据。
 *
 * 这个必须单独抽出来，不能图省事用整段末尾的 ATR —— 那样中间每一根 K 线
 * 都拿到了未来的波动率，回测会虚高，而且同一个位置今天算和明天算结论会变。
 */
export function rollingAtr(bars: Bar[], period = 14): number[] {
  const out: number[] = [];
  const trs: number[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const prev = i > 0 ? bars[i - 1]! : null;
    const tr = prev
      ? Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close))
      : b.high - b.low;
    trs.push(tr);
    sum += tr;
    if (i >= period) sum -= trs[i - period]!;
    out.push(sum / Math.min(i + 1, period));
  }
  return out;
}

/**
 * @param bars 已经走完的 K 线，时间递增
 * @param opts.window   只看最后多少根，默认 30
 * @param opts.limit    最多返回几条，默认 6
 * @param opts.minBodyRatio 实体相对区间的最小比例，过滤掉没意义的碎 K 线
 * @param opts.maxPerKind 同一种形态最多显示几条。这纯粹是展示规则 ——
 *        它相对「数组末尾」计数，所以不参与因果性判断，自检时要传大值把它排除掉。
 */
export function detectPatterns(
  bars: Bar[],
  opts: { window?: number; limit?: number; minBodyRatio?: number; maxPerKind?: number } = {},
): Pattern[] {
  const { window = 30, limit = 6, minBodyRatio = 0.08, maxPerKind = 2 } = opts;
  if (bars.length < 6) return [];

  const atrs = rollingAtr(bars, 14);
  const atrAt = (i: number): number => atrs[i] ?? 0;

  const out: Pattern[] = [];
  const from = Math.max(4, bars.length - window);

  for (let i = from; i < bars.length; i++) {
    const b = bars[i]!;
    const s = shapeOf(b);
    if (s.range <= 0) continue;
    // 一根振幅还不到半个 ATR 的 K 线，什么形态都不值钱
    const a = atrAt(i);
    if (a > 0 && s.range < a * 0.5) continue;

    const bodyRatio = s.body / s.range;
    const prev = bars[i - 1]!;
    const ps = shapeOf(prev);

    // 趋势背景：跟前三根比，收盘是在往下走还是往上走
    const ref = bars[Math.max(0, i - 3)]!.close;
    const drift = (b.close - ref) / (a > 0 ? a : b.close * 0.001);

    const push = (kind: PatternKind, name: string, direction: Pattern['direction'], strength: number, note: string) =>
      out.push({ kind, name, direction, time: b.time, index: i, strength: Math.round(strength), note });

    // 十字星：实体极小。还要求振幅够大 —— 一根窄幅小实体只是没人交易，
    // 不算多空僵持；上下都被推过又收回来才算。
    if (bodyRatio < 0.1 && a > 0 && s.range >= a * 0.8) {
      push('doji', '十字星', 'neutral', 35, `实体只占区间 ${pct(bodyRatio)}，上下都推过又收回来，多空打平`);
      continue;
    }

    // 长下影 + 小实体：下方有人接
    const longLower = s.lower > s.body * 2 && s.upper < s.range * 0.35;
    if (longLower && bodyRatio >= minBodyRatio) {
      if (drift < -0.5) {
        push('hammer', '锤子线', 'bullish', 40 + Math.min(40, (s.lower / s.range) * 60),
          `下影长 ${pct(s.lower / s.range)}、实体 ${pct(bodyRatio)}，跌势里砸下去被买回来了`);
      } else if (drift > 0.5) {
        push('hanging-man', '上吊线', 'bearish', 35 + Math.min(35, (s.lower / s.range) * 50),
          `下影长 ${pct(s.lower / s.range)}，但出现在上涨之后，是获利盘在往下砸`);
      }
      continue;
    }

    // 长上影 + 小实体：上方有人压
    const longUpper = s.upper > s.body * 2 && s.lower < s.range * 0.35;
    if (longUpper && bodyRatio >= minBodyRatio) {
      if (drift > 0.5) {
        push('shooting-star', '射击之星', 'bearish', 40 + Math.min(40, (s.upper / s.range) * 60),
          `上影长 ${pct(s.upper / s.range)}、实体 ${pct(bodyRatio)}，冲高被砸回来了`);
      } else if (drift < -0.5) {
        push('inverted-hammer', '倒锤子', 'bullish', 30 + Math.min(30, (s.upper / s.range) * 40),
          `上影长 ${pct(s.upper / s.range)}，跌势里试探上方，卖压可能减弱了`);
      }
      continue;
    }

    // 吞没：这根把上一根整个吃掉，且方向相反
    const engulfs = b.high >= prev.high && b.low <= prev.low;
    if (engulfs && ps.body > 0 && s.body > ps.body * 1.2) {
      if (s.bull && !ps.bull) {
        push('bullish-engulfing', '看涨吞没', 'bullish', 55 + Math.min(30, (s.body / (a || s.body)) * 15),
          `一根 ${pct(bodyRatio)} 实体的阳线包住了前一根阴线（${prev.close} → ${b.close}）`);
      } else if (!s.bull && ps.bull) {
        push('bearish-engulfing', '看跌吞没', 'bearish', 55 + Math.min(30, (s.body / (a || s.body)) * 15),
          `一根 ${pct(bodyRatio)} 实体的阴线包住了前一根阳线（${prev.close} → ${b.close}）`);
      }
    }
  }

  // 同一根 K 线只留最强的一条，避免图上堆标记
  const best = new Map<number, Pattern>();
  for (const p of out) {
    const cur = best.get(p.index);
    if (!cur || p.strength > cur.strength) best.set(p.index, p);
  }
  // 同一种形态最多留两条：十字星最容易泛滥，连着四根倒锤子也说明不了更多事情
  const sorted = [...best.values()].sort((x, y) => y.index - x.index);
  const counts = new Map<string, number>();
  return sorted
    .filter((p) => {
      const n = counts.get(p.kind) ?? 0;
      if (n >= maxPerKind) return false;
      counts.set(p.kind, n + 1);
      return true;
    })
    .slice(0, limit);
}
