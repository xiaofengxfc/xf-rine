/**
 * 支撑位 / 阻力位识别。
 *
 * 只看「当前 bar 之前」的数据，任何一根 K 线在生成自己的结论时都不会用到它后面的数据，
 * 所以同一段历史在实盘和回测里给出的位是一致的（no-lookahead）。
 *
 * 打分融合四路证据：
 *   1. 摆动点（swing pivot）聚类 —— 价格在这里反复转向，是最主要的结构证据
 *   2. 成交量分布（volume profile）—— 位附近累计成交量越大，越是有真实筹码承接
 *   3. 假突破次数 —— 被捅穿又收回来，说明这个位置的防守是有力量的
 *   4. 整数关口 / 近期性 —— 人类挂单偏好，以及越新的触及越有参考价值
 */

export interface Bar {
  time: number;   // unix 秒
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Level {
  price: number;
  role: 'support' | 'resistance';
  strength: number;      // 0-100
  touches: number;
  failures: number;      // 假突破次数
  volumeRatio: number;   // 0-1，该位所在价格桶的成交量相对最大桶
  distancePct: number;   // 相对最新价
  lastTouch: number;     // unix 秒
  zoneLow: number;
  zoneHigh: number;
}

export interface LevelSet {
  levels: Level[];
  atr: number;
  last: number;
  rangeHigh: number;
  rangeLow: number;
  nearestSupport: Level | null;
  nearestResistance: Level | null;
}

interface Pivot { index: number; price: number; time: number; kind: 'high' | 'low' }

/** Wilder ATR */
export function atr(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const n = Math.min(period, bars.length - 1);
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    sum += tr;
  }
  return sum / n;
}

/** 局部极值：一根 bar 的高/低是前后 k 根里的极值 */
function pivots(bars: Bar[], k: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < bars.length - k; i++) {
    const b = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const o = bars[j]!;
      if (o.high >= b.high) isHigh = false;
      if (o.low <= b.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, price: b.high, time: b.time, kind: 'high' });
    if (isLow) out.push({ index: i, price: b.low, time: b.time, kind: 'low' });
  }
  return out;
}

/** 成交量分布：把价格区间切成桶，bar 的成交量按 high-low 覆盖的桶摊进去 */
function volumeProfile(bars: Bar[], binSize: number, low: number, high: number): { vol: Map<number, number>; max: number } {
  const vol = new Map<number, number>();
  const bin = (p: number) => Math.round((p - low) / binSize);
  for (const b of bars) {
    const lo = bin(b.low);
    const hi = bin(b.high);
    const span = Math.max(1, hi - lo + 1);
    const each = b.volume / span;
    for (let i = lo; i <= hi; i++) vol.set(i, (vol.get(i) ?? 0) + each);
  }
  let max = 0;
  for (const v of vol.values()) if (v > max) max = v;
  return { vol, max };
}

/** 位附近窗口内的累计成交量相对全图最大桶的比例 */
function volumeNear(profile: { vol: Map<number, number>; max: number }, binSize: number, low: number, price: number, tolerance: number): number {
  if (profile.max <= 0) return 0;
  const centre = Math.round((price - low) / binSize);
  const reach = Math.max(1, Math.ceil(tolerance / binSize));
  let sum = 0;
  for (let i = centre - reach; i <= centre + reach; i++) sum += profile.vol.get(i) ?? 0;
  return Math.min(1, sum / (profile.max * (reach * 2 + 1) * 0.5));
}

/** 价格是否靠近“人类爱挂单”的整数位 */
function roundNumberScore(price: number): number {
  if (price <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(price));
  const step = magnitude / 100;
  if (!Number.isFinite(step) || step <= 0) return 0;
  const off = Math.abs(price / step - Math.round(price / step));
  return 1 - Math.min(1, off * 2);
}

/** 假突破：影线越过位超过一个容差、但收盘收回来 */
function countFailures(bars: Bar[], price: number, tolerance: number, kind: 'high' | 'low'): number {
  let n = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    if (kind === 'high') {
      if (b.high > price + tolerance && b.close < price) n++;
    } else {
      if (b.low < price - tolerance && b.close > price) n++;
    }
  }
  return n;
}

export interface LevelOptions {
  /** 摆动点窗口，越小位越多越敏感 */
  pivotWindow?: number;
  /** 聚类容差 = max(toleranceAtr * ATR, tolerancePct * price) */
  toleranceAtr?: number;
  tolerancePct?: number;
  /** 最多返回几个位 */
  maxLevels?: number;
  /** 只保留距最新价这个百分比以内的位 */
  maxDistancePct?: number;
  /** 只保留强度不低于这个值的位 */
  minStrength?: number;
  /** 新鲜度半衰期，按 bar 根数算 */
  halfLifeBars?: number;
  /** 第二级聚类放大倍数：相邻位的间距小于 tolerance × mergeFactor 就并成一条带 */
  mergeFactor?: number;
}

export function detectLevels(input: Bar[], opts: LevelOptions = {}): LevelSet {
  const {
    pivotWindow = 3,
    toleranceAtr = 0.45,
    tolerancePct = 0.0015,
    maxLevels = 8,
    maxDistancePct = 12,
    minStrength = 25,
    halfLifeBars = 120,
    mergeFactor = 2.2,
  } = opts;

  const bars = input.filter((b) => Number.isFinite(b.close) && b.high >= b.low);
  const empty: LevelSet = { levels: [], atr: 0, last: 0, rangeHigh: 0, rangeLow: 0, nearestSupport: null, nearestResistance: null };
  if (bars.length < 20) return empty;

  const last = bars[bars.length - 1]!.close;
  const atrValue = atr(bars, 14);
  const rangeHigh = Math.max(...bars.map((b) => b.high));
  const rangeLow = Math.min(...bars.map((b) => b.low));
  const tolerance = Math.max(toleranceAtr * atrValue, tolerancePct * last);
  const binSize = Math.max(0.35 * atrValue, (rangeHigh - rangeLow) / 200) || (last * 0.001);
  const profile = volumeProfile(bars, binSize, rangeLow, rangeHigh);

  const pts = pivots(bars, pivotWindow);
  if (pts.length === 0) return { ...empty, atr: atrValue, last, rangeHigh, rangeLow };

  // 按价格排序后做单链聚类：相邻间隔小于容差就并成一组
  pts.sort((a, b) => a.price - b.price);
  const groupBy = (list: Pivot[], tol: number): Pivot[][] => {
    const groups: Pivot[][] = [];
    let cur: Pivot[] = [];
    let sum = 0;
    for (const p of list) {
      const mean = cur.length ? sum / cur.length : 0;
      if (cur.length === 0 || p.price - mean <= tol) {
        cur.push(p);
        sum += p.price;
      } else {
        groups.push(cur);
        cur = [p];
        sum = p.price;
      }
    }
    if (cur.length) groups.push(cur);
    return groups;
  };

  // 两级聚类：先用容差把同一位置的摆动点归堆，再把挨得近的堆并成一条「带」。
  // 单用第一级会把一个阻力带拆成 4 条只差 0.3% 的线，图上看起来像噪声。
  const firstPass = groupBy(pts, tolerance);
  const clusters: { members: Pivot[] }[] = [];
  for (const g of firstPass) {
    const cur = clusters[clusters.length - 1];
    const mean = (m: Pivot[]) => m.reduce((s, p) => s + p.price, 0) / m.length;
    if (cur && mean(g) - mean(cur.members) <= tolerance * mergeFactor) {
      cur.members.push(...g);
    } else {
      clusters.push({ members: [...g] });
    }
  }

  const lastIndex = bars.length - 1;
  const levels: Level[] = [];

  for (const c of clusters) {
    const price = c.members.reduce((s, p) => s + p.price, 0) / c.members.length;
    const touches = c.members.length;
    const newest = c.members.reduce((m, p) => Math.max(m, p.index), 0);
    const ageBars = Math.max(0, lastIndex - newest);
    const recency = Math.exp(-ageBars / halfLifeBars);
    const volRatio = volumeNear(profile, binSize, rangeLow, price, tolerance);
    const kind: 'high' | 'low' = c.members.filter((p) => p.kind === 'high').length >= c.members.length / 2 ? 'high' : 'low';
    const failures = countFailures(bars, price, tolerance, kind);
    const round = roundNumberScore(price);

    // 权重：触及次数是主证据，成交量与新鲜度次之
    const touchScore = Math.min(1, touches / 5);
    const failScore = Math.min(1, failures / 3);
    const strength = Math.round(
      (touchScore * 42 + volRatio * 24 + recency * 16 + failScore * 10 + round * 8) * 100,
    ) / 100;

    if (strength < minStrength) continue;
    const distancePct = ((price - last) / last) * 100;
    if (Math.abs(distancePct) > maxDistancePct) continue;

    levels.push({
      price,
      role: price <= last ? 'support' : 'resistance',
      strength: Math.min(100, strength),
      touches,
      failures,
      volumeRatio: Math.round(volRatio * 100) / 100,
      distancePct: Math.round(distancePct * 1000) / 1000,
      lastTouch: c.members.reduce((m, p) => Math.max(m, p.time), 0),
      zoneLow: price - tolerance,
      zoneHigh: price + tolerance,
    });
  }

  // 上下各取一半：否则行情贴着区间底走的时候，8 个位会全是阻力，
  // 做多的止损就无处可放，只能退回 ATR，自动档位就失去意义了。
  const above = levels.filter((l) => l.price > last).sort((a, b) => b.strength - a.strength);
  const below = levels.filter((l) => l.price <= last).sort((a, b) => b.strength - a.strength);
  // 每侧最多占一半名额。下跌途中价格贴近区间底部时，下方的摆动低点本就极少
  // （新低的下方还在创新低，永远成不了确认的摆动点），这时候若让上方把 8 个名额占满，
  // 图上会叠 8 条阻力线把 K 线压扁。少画几条，换来图表可读。
  const half = Math.ceil(maxLevels / 2);
  const kept = [
    ...above.slice(0, half),
    ...below.slice(0, Math.max(1, maxLevels - half)),
  ].sort((a, b) => b.price - a.price);

  const supports = kept.filter((l) => l.price <= last);
  const resistances = kept.filter((l) => l.price > last);

  return {
    levels: kept,
    atr: atrValue,
    last,
    rangeHigh,
    rangeLow,
    nearestSupport: supports.length ? supports.reduce((a, b) => (b.price > a.price ? b : a)) : null,
    nearestResistance: resistances.length ? resistances.reduce((a, b) => (b.price < a.price ? b : a)) : null,
  };
}

export type Direction = 'long' | 'short';

export interface Bracket {
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  stopSource: string;
  targetSource: string;
  stopDistancePct: number;
  targetDistancePct: number;
  /** 建议的止损宽度占总价百分比，给下单面板换算张数用 */
  riskPct: number;
  /** 盈亏比是否达到最低要求；达不到也返回方案，但页面要标红，不装作能用 */
  acceptable: boolean;
  minRR: number;
}

/**
 * 从识别出的位推导止盈止损：
 * 多头止损放在最近的强支撑下方一个缓冲，止盈放在最近能满足最小盈亏比的强阻力；
 * 找不到合格位就退回 ATR 倍数，并说明来源，不假装是结构位。
 */
export function planBracket(
  set: LevelSet,
  direction: Direction,
  opts: {
    minStrength?: number; minRR?: number; atrBuffer?: number;
    atrStop?: number; atrTarget?: number; minStopAtr?: number;
  } = {},
): Bracket | null {
  const {
    minStrength = 35, minRR = 1.5, atrBuffer = 0.3, atrStop = 1.5, atrTarget = 2.5, minStopAtr = 0.8,
  } = opts;
  const { last, atr: a } = set;
  if (!last || !a) return null;

  const buffer = Math.max(atrBuffer * a, last * 0.0005);
  // 止损最窄 0.8 个 ATR：支撑正好贴在入场价下方时，按位推出来的止损只有 0.1%，
  // 一个正常的抖动就打掉了，还顺手把盈亏比算成 10 倍这种假数字。
  const minRisk = minStopAtr * a;
  const strong = set.levels.filter((l) => l.strength >= minStrength);
  // 止损只需要「可信的防护」，止盈必须是「真实的障碍」，所以两者的强度门槛不同。
  const weak = Math.min(minStrength, Math.max(0, minStrength * 0.6));
  // 止损最远放 4%：再远就不是日内单了，宁可承认这笔不值得做
  const maxStopPct = 4;

  /** 找最近的一侧位，强度过线且距离不超过 maxStopPct */
  const nearest = (side: 'below' | 'above', threshold: number): Level | null => {
    const pool = set.levels
      .filter((l) => (side === 'below' ? l.price < last : l.price > last))
      .filter((l) => l.strength >= threshold)
      .filter((l) => (Math.abs(l.price - last) / last) * 100 <= maxStopPct)
      .sort((x, y) => (side === 'below' ? y.price - x.price : x.price - y.price));
    return pool[0] ?? null;
  };

  if (direction === 'long') {
    // 下方没有任何像样的支撑时，止损只能退回 ATR —— 会如实写进 stopSource，不冒充结构位
    const stopLevel = nearest('below', weak);
    let stop = stopLevel ? stopLevel.price - buffer : last - atrStop * a;
    let stopSource = stopLevel
      ? `支撑 ${fmt(stopLevel.price)}（强度 ${Math.round(stopLevel.strength)}）`
      : `ATR × ${atrStop}（下方没有像样的支撑）`;
    if (last - stop < minRisk) {
      stop = last - minRisk;
      if (stopLevel) stopSource += `，离入场不足 ${minStopAtr} ATR，止损已放宽`;
    }
    const risk = last - stop;
    if (risk <= 0) return null;

    // 目标取上方最近的强阻力。不为了凑盈亏比去挑更远的那条：
    // 更远的阻力前面还挡着一条，实际走不到，那样报出来的盈亏比是假的。
    const targetLevel = nearest('above', minStrength);
    const target = targetLevel ? targetLevel.price : last + atrTarget * a;

    return {
      direction,
      entry: last,
      stop,
      target,
      riskReward: Math.round(((target - last) / risk) * 100) / 100,
      stopSource,
      targetSource: targetLevel ? `阻力 ${fmt(targetLevel.price)}（强度 ${Math.round(targetLevel.strength)}）` : `ATR × ${atrTarget}（上方没有够强的阻力）`,
      stopDistancePct: Math.round((risk / last) * 10000) / 100,
      targetDistancePct: Math.round(((target - last) / last) * 10000) / 100,
      riskPct: Math.round((risk / last) * 10000) / 100,
      acceptable: (target - last) / risk >= minRR,
      minRR,
    };
  }

  const stopLevel = nearest('above', weak);
  let stop = stopLevel ? stopLevel.price + buffer : last + atrStop * a;
  let stopSource = stopLevel
    ? `阻力 ${fmt(stopLevel.price)}（强度 ${Math.round(stopLevel.strength)}）`
    : `ATR × ${atrStop}（上方没有像样的阻力）`;
  if (stop - last < minRisk) {
    stop = last + minRisk;
    if (stopLevel) stopSource += `，离入场不足 ${minStopAtr} ATR，止损已放宽`;
  }
  const risk = stop - last;
  if (risk <= 0) return null;

  const targetLevel = nearest('below', minStrength);
  const target = targetLevel ? targetLevel.price : last - atrTarget * a;

  return {
    direction,
    entry: last,
    stop,
    target,
    riskReward: Math.round(((last - target) / risk) * 100) / 100,
    stopSource,
    targetSource: targetLevel ? `支撑 ${fmt(targetLevel.price)}（强度 ${Math.round(targetLevel.strength)}）` : `ATR × ${atrTarget}（下方没有够强的支撑）`,
    stopDistancePct: Math.round((risk / last) * 10000) / 100,
    targetDistancePct: Math.round(((last - target) / last) * 10000) / 100,
    riskPct: Math.round((risk / last) * 10000) / 100,
    acceptable: (last - target) / risk >= minRR,
    minRR,
  };
}

function fmt(p: number): string {
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(6).replace(/0+$/, '');
}
