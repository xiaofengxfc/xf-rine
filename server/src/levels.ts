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
  /**
   * 几个周期上同时有这条位。1 = 只有当前周期，2 = 更粗的周期也认。
   * 只在接口层由 applyConfluence 填，detectLevels 自己不管
   */
  confluence?: number;
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

export interface Pivot { index: number; price: number; time: number; kind: 'high' | 'low' }

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

/**
 * 局部极值：一根 bar 的高/低是前后 k 根里的极值。
 *
 * 要求右侧也有 k 根，所以返回的每一个点都是「已经确认」的 ——
 * structure.ts 直接拿它判 BOS / CHoCH，靠的就是这个性质。
 */
export function pivots(bars: Bar[], k: number): Pivot[] {
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

/**
 * 把 K 线按 factor 根合成一根（时间取这一组的第一根）。
 *
 * 多周期一致性不另外去交易所拉一遍长周期：同一批数据自己聚一次就够了 ——
 * 少一次网络往返，也就不存在「两个周期来自两个时刻」的错位。
 */
export function resampleBars(bars: Bar[], factor: number): Bar[] {
  const n = Math.max(1, Math.floor(factor));
  if (n === 1) return bars.map((b) => ({ ...b }));
  const out: Bar[] = [];
  // 只取整组：末尾不足 n 根的那一组丢掉。留着的话，每来一根新 K 线这一组就变一次，
  // 粗周期的位会跟着抖 —— 那种位比没有更糟
  for (let i = 0; i + n <= bars.length; i += n) {
    const group = bars.slice(i, i + n);
    const first = group[0]!;
    let high = first.high;
    let low = first.low;
    let volume = 0;
    for (const b of group) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
    }
    out.push({
      time: first.time,
      open: first.open,
      high,
      low,
      close: group[group.length - 1]!.close,
      volume,
    });
  }
  return out;
}

/**
 * 多周期一致性：更粗的周期也认同一条位，这条位就更硬。
 *
 * 这是「更多结构分析」里最省钱的一项 —— 位本身没变，只是把「5 分钟上碰了三次」
 * 和「5 分钟、20 分钟、1 小时上都碰过」区分开。强度乘 1.15 再加 5 分，封顶 100，
 * 不打乱原来的排序，只是在同一批位里把更硬的往前推。
 */
export function applyConfluence(levels: Level[], coarse: Level[], atr: number, last: number): Level[] {
  if (coarse.length === 0 || levels.length === 0) return levels;
  // 容差和 detectLevels 里判「同一条带」的量级一致：位本身就差半个 ATR 以内就算同一条
  const tol = Math.max(0.5 * atr, last * 0.0015);
  return levels.map((l) => {
    const hit = coarse.some((c) => Math.abs(c.price - l.price) <= tol);
    if (!hit) return { ...l, confluence: 1 };
    return { ...l, strength: Math.min(100, Math.round((l.strength * 1.15 + 5) * 100) / 100), confluence: 2 };
  });
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

export type EntryKind = 'market' | 'level' | 'range' | 'atr';

export interface Bracket {
  direction: Direction;
  entry: number;
  /** 这个入场价怎么来的：结构位回踩 / 区间中位 / ATR 回撤 / 就是现价 */
  entryKind: EntryKind;
  entrySource: string;
  /** 入场价相对现价的偏离（%，带符号）。负数＝要等价格回落才成交 */
  entryDistancePct: number;
  /** 同一个偏离折算成 ATR 倍数：判断这点距离今天走不走得动 */
  entryDistanceAtr: number;
  stop: number;
  target: number;
  riskReward: number;
  stopSource: string;
  targetSource: string;
  stopDistancePct: number;
  targetDistancePct: number;
  /** 建议的止损宽度占入场价的百分比，给下单面板换算张数用 */
  riskPct: number;
  /** 盈亏比是否达到最低要求；达不到也返回方案，但页面要标红，不装作能用 */
  acceptable: boolean;
  minRR: number;
}

/**
 * 从识别出的位推导「在哪儿进、止损止盈放哪儿」。
 *
 * 入场默认按**限价回踩**算（entryMode: 'limit'）。按现价进场看着简单，但它把
 * 「这个价该不该进」整个跳过了：现价正贴着阻力时，止损只能放远、止盈只能放近，
 * 报出来就是盈亏比 0.27 这种「结构不支持」，而结构本来没那么差，差的是入场位置。
 * 同一段结构改成回踩支撑上沿，止损从 1.4 ATR 缩到 0.8 ATR、止盈不变，盈亏比翻好几倍。
 *
 * 定价顺序（做多，空头镜像）：
 *   1. 现价下方最近一条够强的支撑 → 挂在它的上沿（碰到就成交，不用等正好打到位）；
 *   2. 没有能等的位、但结构是区间 → 挂区间中位（区间太窄就不算区间）；
 *   3. 还是没有 → 按 ATR 回撤让一点，并写明「附近没有能等的结构位」。
 * 勾不到的结构位（离现价超过 maxEntryAtr、或者已经跑到现价另一边）一律不用 ——
 * 挂在那儿今天大概等不到，那种方案等于没有。
 */
export function planBracket(
  set: LevelSet,
  direction: Direction,
  opts: {
    minStrength?: number; minRR?: number; atrBuffer?: number;
    atrStop?: number; atrTarget?: number; minStopAtr?: number;
    /** 限价回踩（默认）还是按现价算 */
    entryMode?: 'limit' | 'market';
    /** 结构位超过这么多 ATR 就不等它了 */
    maxEntryAtr?: number;
    /** 没有结构位时按几倍 ATR 回撤入场 */
    atrEntry?: number;
    /**
     * 入场价离现价超过这个百分比就不要了，退回按现价进。
     * 交易所对限价单有偏离上限（每个合约至少 5%，见 routes 里的 PRICE_DEVIATE），
     * 挂太远不是「等回踩」，是下单直接被拒。
     */
    maxEntryPct?: number;
  } = {},
): Bracket | null {
  const {
    minStrength = 35, minRR = 1.5, atrBuffer = 0.3, atrStop = 1.5, atrTarget = 2.5, minStopAtr = 0.8,
    entryMode = 'limit', maxEntryAtr = 1.5, atrEntry = 0.6, maxEntryPct = 3,
  } = opts;
  const { last, atr: a } = set;
  if (!last || !a) return null;

  const long = direction === 'long';
  const buffer = Math.max(atrBuffer * a, last * 0.0005);
  // 止损最窄 0.8 个 ATR：支撑正好贴在入场价下方时，按位推出来的止损只有 0.1%，
  // 一个正常的抖动就打掉了，还顺手把盈亏比算成 10 倍这种假数字。
  const minRisk = minStopAtr * a;
  // 止损只需要「可信的防护」，止盈必须是「真实的障碍」，所以两者的强度门槛不同。
  const weak = Math.min(minStrength, Math.max(0, minStrength * 0.6));
  // 止损最远放 4%：再远就不是日内单了，宁可承认这笔不值得做
  const maxStopPct = 4;
  /** 挂单价贴在位的哪一侧：多单挂支撑上沿，空单挂阻力下沿 */
  const pad = 0.15 * a;
  /** 偏离小于这个就当市价：挂在那个位置等于立刻成交，别装成回踩 */
  const negligible = 0.15 * a;
  /** 这个价是不是真在现价的「这一侧」——回踩才有意义 */
  const behind = (price: number) => (long ? price < last - negligible : price > last + negligible);

  // ---------- 入场价 ----------
  let entry = last;
  let entryKind: EntryKind = 'market';
  let entrySource = '按现价进（入场就是最新价）';

  if (entryMode === 'limit') {
    const level = set.levels
      .filter((l) => l.strength >= minStrength)
      .filter((l) => (long ? l.price < last : l.price > last))
      .filter((l) => Math.abs(l.price - last) / a <= maxEntryAtr)
      .sort((x, y) => (long ? y.price - x.price : x.price - y.price))[0] ?? null;
    const want = level ? (long ? level.price + pad : level.price - pad) : 0;
    if (level && behind(want)) {
      entry = want;
      entryKind = 'level';
      entrySource = (long ? '回踩支撑 ' : '反抽阻力 ') + fmt(level.price)
        + '（强度 ' + Math.round(level.strength) + '）的' + (long ? '上沿' : '下沿');
    }
  }

  if (entryKind === 'market' && entryMode === 'limit') {
    const hi = set.rangeHigh;
    const lo = set.rangeLow;
    // 区间不到 2 ATR 就不是「区间」，中位没有意义
    if (hi > lo && hi - lo >= 2 * a) {
      const mid = (hi + lo) / 2;
      if (behind(mid)) {
        entry = mid;
        entryKind = 'range';
        entrySource = '区间中位 ' + fmt(mid) + '（区间 ' + fmt(lo) + ' - ' + fmt(hi) + '）';
      }
    }
  }

  if (entryKind === 'market' && entryMode === 'limit' && atrEntry > 0) {
    const want = long ? last - atrEntry * a : last + atrEntry * a;
    if (behind(want)) {
      entry = want;
      entryKind = 'atr';
      entrySource = 'ATR × ' + atrEntry + ' 回撤（附近没有能等的结构位）';
    }
  }

  // 挂得太远会被交易所的偏离上限拒掉，这里留出余量，退回按现价进
  if (entryKind !== 'market' && (Math.abs(entry - last) / last) * 100 > maxEntryPct) {
    entry = last;
    entryKind = 'market';
    entrySource = '按现价进（够得着的结构位都超出挂单距离上限）';
  }

  // ---------- 止损 / 止盈：一律相对入场价 ----------
  /** 找最近的一侧位，强度过线且距离入场价不超过 maxStopPct */
  const nearest = (side: 'below' | 'above', threshold: number): Level | null => {
    const pool = set.levels
      .filter((l) => (side === 'below' ? l.price < entry : l.price > entry))
      .filter((l) => l.strength >= threshold)
      .filter((l) => (Math.abs(l.price - entry) / entry) * 100 <= maxStopPct)
      .sort((x, y) => (side === 'below' ? y.price - x.price : x.price - y.price));
    return pool[0] ?? null;
  };

  const stopLevel = nearest(long ? 'below' : 'above', weak);
  let stop = stopLevel
    ? (long ? stopLevel.price - buffer : stopLevel.price + buffer)
    : (long ? entry - atrStop * a : entry + atrStop * a);
  let stopSource = stopLevel
    ? (long ? '支撑 ' : '阻力 ') + fmt(stopLevel.price) + '（强度 ' + Math.round(stopLevel.strength) + '）'
    : 'ATR × ' + atrStop + '（' + (long ? '下方没有像样的支撑' : '上方没有像样的阻力') + '）';
  if (Math.abs(entry - stop) < minRisk) {
    stop = long ? entry - minRisk : entry + minRisk;
    if (stopLevel) stopSource += '，离入场不足 ' + minStopAtr + ' ATR，止损已放宽';
  }
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;

  // 目标取那一侧最近的强位。不为了凑盈亏比去挑更远的那条：
  // 更远的位前面还挡着一条，实际走不到，那样报出来的盈亏比是假的。
  const targetLevel = nearest(long ? 'above' : 'below', minStrength);
  const target = targetLevel ? targetLevel.price : (long ? entry + atrTarget * a : entry - atrTarget * a);
  const reward = Math.abs(target - entry);

  return {
    direction,
    entry,
    entryKind,
    entrySource,
    entryDistancePct: Math.round(((entry - last) / last) * 10000) / 100,
    entryDistanceAtr: Math.round((Math.abs(entry - last) / a) * 100) / 100,
    stop,
    target,
    riskReward: Math.round((reward / risk) * 100) / 100,
    stopSource,
    targetSource: targetLevel
      ? (long ? '阻力 ' : '支撑 ') + fmt(targetLevel.price) + '（强度 ' + Math.round(targetLevel.strength) + '）'
      : 'ATR × ' + atrTarget + '（' + (long ? '上方没有够强的阻力' : '下方没有够强的支撑') + '）',
    stopDistancePct: Math.round((risk / entry) * 10000) / 100,
    targetDistancePct: Math.round((reward / entry) * 10000) / 100,
    riskPct: Math.round((risk / entry) * 10000) / 100,
    acceptable: reward / risk >= minRR,
    minRR,
  };
}

function fmt(p: number): string {
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(6).replace(/0+$/, '');
}

export interface PositionPlan {
  direction: Direction;
  /** 锚在持仓成本上，不是现价 —— 这是「分析当前持仓」和「开仓前算方案」的分界 */
  entry: number;
  stop: number;
  target: number;
  /** 从成本价算：正数 = 这一单要亏多少，负数 = 止损已经推到成本上方、锁住了利润 */
  riskFromEntry: number;
  rewardFromEntry: number;
  riskPct: number;
  rewardPct: number;
  /** 成本口径的盈亏比。止损已在成本上方时它没有意义，给 null */
  riskReward: number | null;
  acceptable: boolean;
  minRR: number;
  stopSource: string;
  targetSource: string;
  /** 收盘已经收在那条关键结构位的另一侧：这张仓原来的结构没了 */
  broken: boolean;
  /** 止损在成本上方，最差也是保本 */
  locksProfit: boolean;
  /** 成本口径的风险超过每日上限 —— 等于把风险又放宽一截 */
  tooWide: boolean;
  /** 能不能真挂上。现价已经跑过的那一边，挂上去当场就成交 */
  mountable: { stop: boolean; target: boolean };
  notes: string[];
}

export interface PositionPlanOptions {
  minStrength?: number;
  minRR?: number;
  atrBuffer?: number;
  atrStop?: number;
  atrTarget?: number;
  /** 成本口径的风险上限（%）。超过就说这张仓的止损已经是在放宽风险 */
  maxRiskPct?: number;
  /** 结构状态。逆势的仓要单独提醒一句 —— 逆势单的止损本来就是用来被打的 */
  trend?: 'up' | 'down' | 'range';
}

/**
 * 给「已经拿在手上的仓」推导止盈止损。
 *
 * 和 planBracket 只差一件事，后果却很大：锚点从最新价换成持仓成本。
 * 开仓前的方案问的是「现在进场，止损放哪」；持仓后的方案问的是
 * 「这笔已经开的单，从成本算到底要亏多少、还值不值得守」—— 后者才是真正会赔的钱。
 *
 * 因为止损只能挂在现价的另一侧，成本口径的风险永远大于等于当前的浮亏。
 * 所以这里不假装能把风险收窄：算出来偏大就直说偏大（tooWide），
 * 结构破了就直说破了（broken），交给页面去劝人离场，而不是悄悄把止损放远。
 */
export function planPositionBracket(
  set: LevelSet,
  pos: { direction: Direction; entry: number; last: number; mark?: number },
  opts: PositionPlanOptions = {},
): PositionPlan | null {
  const {
    minStrength = 35, minRR = 1.5, atrBuffer = 0.3,
    atrStop = 1.5, atrTarget = 2.5, maxRiskPct = 4, trend,
  } = opts;
  const a = set.atr;
  const entry = pos.entry;
  const last = pos.last > 0 ? pos.last : (pos.mark ?? 0);
  const mark = pos.mark && pos.mark > 0 ? pos.mark : last;
  if (!(entry > 0) || !(last > 0) || !(a > 0)) return null;

  const long = pos.direction === 'long';
  // 判「现价在哪」时取更严格的那个：止损正好落在最新价和标记价之间时，
  // 只看一个会放过它，挂上去那一秒就成交（服务端的 checkTriggerPrices 也是这个口径）
  const adverse = long ? Math.min(last, mark) : Math.max(last, mark);
  const far = long ? Math.max(last, mark) : Math.min(last, mark);
  const buffer = Math.max(atrBuffer * a, entry * 0.0005);
  const weak = Math.min(minStrength, Math.max(0, minStrength * 0.6));
  const notes: string[] = [];

  // 止损：现价「更差」那一侧最近的强位。挂得比现价更差才挂得住
  const stopPool = set.levels
    .filter((l) => l.strength >= weak)
    .filter((l) => (long ? l.price < adverse : l.price > adverse))
    .sort((x, y) => (long ? y.price - x.price : x.price - y.price));
  const stopLevel = stopPool[0] ?? null;
  const stop = stopLevel
    ? (long ? stopLevel.price - buffer : stopLevel.price + buffer)
    : (long ? adverse - atrStop * a : adverse + atrStop * a);
  const stopSource = stopLevel
    ? (long ? '支撑 ' : '阻力 ') + fmt(stopLevel.price) + '（强度 ' + Math.round(stopLevel.strength) + '）'
    : 'ATR × ' + atrStop + '（现价' + (long ? '下' : '上') + '方没有够强的' + (long ? '支撑' : '阻力') + '）';
  if (!stopLevel) notes.push('现价这一侧没有像样的结构位，止损只能按波动率放。');

  // 止盈：现价「更好」那一侧最近的强位。已经走过的那条不再是障碍，
  // 所以不为了凑盈亏比去挑更远的一条 —— 和开仓前的方案同一个口径
  const targetPool = set.levels
    .filter((l) => l.strength >= minStrength)
    .filter((l) => (long ? l.price > far : l.price < far))
    .sort((x, y) => (long ? x.price - y.price : y.price - x.price));
  const targetLevel = targetPool[0] ?? null;
  // ATR 兜底也从成本算：从现价算会把「已经走了一段」当成起点，止盈离得越来越近
  const atrTargetPrice = long ? entry + atrTarget * a : entry - atrTarget * a;
  const reachable = long ? Math.max(atrTargetPrice, far + buffer) : Math.min(atrTargetPrice, far - buffer);
  const target = targetLevel ? targetLevel.price : reachable;
  const targetSource = targetLevel
    ? (long ? '阻力 ' : '支撑 ') + fmt(targetLevel.price) + '（强度 ' + Math.round(targetLevel.strength) + '）'
    : 'ATR × ' + atrTarget + '（现价' + (long ? '上' : '下') + '方没有够强的' + (long ? '阻力' : '支撑') + '）';
  if (!targetLevel) notes.push('没有够强的目标位，止盈按波动率放。');

  const risk = long ? entry - stop : stop - entry;
  const reward = long ? target - entry : entry - target;
  const riskPct = Math.round((risk / entry) * 10000) / 100;
  const rewardPct = Math.round((reward / entry) * 10000) / 100;
  const riskReward = risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
  const locksProfit = risk < 0;
  const tooWide = riskPct > maxRiskPct;

  // 结构破没破：成本下方（上方）那条最强的关键位，收盘已经跑到它另一边，就是破了。
  // 破了之后能找到的止损都在破位之后，挂上去等于把风险再放宽一截 —— 这是要劝离场的信号
  const keyLevel = set.levels
    .filter((l) => l.strength >= minStrength)
    .filter((l) => (long ? l.price < entry : l.price > entry))
    .sort((x, y) => (long ? y.price - x.price : x.price - y.price))[0] ?? null;
  // 贴着位不算破：收盘要落到位之外一个缓冲，才叫真的跌（涨）破了它。
  // 不这么收一下，价格正好踩在位上时会被判成破位，一句「结构没了」就成了噪声。
  const broken = keyLevel
    ? (long ? adverse < keyLevel.price - buffer : adverse > keyLevel.price + buffer)
    : false;

  if (broken && keyLevel) {
    notes.push(
      '收盘已经' + (long ? '跌' : '涨') + '破' + (long ? '支撑' : '阻力') + ' ' + fmt(keyLevel.price) +
      '，这张仓的结构没了。还挂得上的止损都在破位之后，等于把风险再放宽一截 —— 更该考虑按市价离场。',
    );
  }
  // 逆势单：结构方向和这张仓相反。这不是「不能做」，但止损更容易被打，得说出来
  if (trend && trend !== 'range' && (trend === 'up') !== long) {
    notes.push(
      '结构在往' + (trend === 'up' ? '上' : '下') + '走，这张' + (long ? '多' : '空')
      + '单是逆势的 —— 这一侧的止损本来就是用来被打的。',
    );
  }
  if (locksProfit) {
    notes.push('止损 ' + fmt(stop) + ' 已经在成本价之上，这笔单最差也是保本。');
  } else if (tooWide) {
    notes.push('从成本算要亏 ' + riskPct + '%，超过 ' + maxRiskPct + '% 的日内上限。');
  }
  // 最近的障碍还在成本这一边：按它挂止盈就是亏损离场，不是止盈。这必须说出来，
  // 否则面板上那个「止盈」看着像目标，实际是个更小的亏。
  if (targetLevel && reward <= 0) {
    notes.push(
      '最近的' + (long ? '阻力 ' : '支撑 ') + fmt(targetLevel.price) + ' 还在成本' + (long ? '下' : '上')
      + '方，按它挂止盈是带着亏损离场，不是止盈。',
    );
  }

  const mountable = {
    stop: stop > 0 && (long ? stop < adverse : stop > adverse),
    target: target > 0 && (long ? target > far : target < far),
  };

  return {
    direction: pos.direction,
    entry,
    stop,
    target,
    riskFromEntry: risk,
    rewardFromEntry: reward,
    riskPct,
    rewardPct,
    riskReward,
    acceptable: riskReward === null ? true : riskReward >= minRR,
    minRR,
    stopSource,
    targetSource,
    broken,
    locksProfit,
    tooWide,
    mountable,
    notes,
  };
}
