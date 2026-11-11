/**
 * 支撑位 / 阻力位识别。
 *
 * 移植自 rosemarycox5334-debug/Detect_support_and_resistance_levels 的 V3Fusion
 * （src/srlab/{profile,pivots,detectors,base}.py）。那套东西是在 A 股上做过对照实验调出来的，
 * 有几条取舍值得照抄，也有几条刻意没抄（下面逐条说明）。
 *
 * 流程：六路证据 → 融合出「定位面」找候选 → 每个候选定区宽、算历史守住率 → 排序 → NMS。
 *   1. 成交量剖面：体积守恒（一根 K 线的量均摊到它覆盖的箱，不是全额砸进每个箱），
 *      箱宽 = 0.25×ATR（下限取最小变动价），60 根半衰期做时间衰减
 *   2. 收盘价堆积：市场「认可」的价格，比全区间更聚焦
 *   3. 枢轴聚集：ATR 阈值 ZigZag（反向走 2×ATR 才确认这个极值），破位后角色互换保留 40%
 *   4. 历史守住率：同一次进入只算一次（5 根冷却），要求从正确方向接近，
 *      突破/达标阈值都按「当时」的 ATR 化，样本不足给 Wilson 下界
 *   5. 整数关口：原作者实测无信息量，权重归零，函数留着便于对照
 *   6. 近期性：方向与直觉相反 —— 越久没被碰过越强，所以用 stale 而不是 recency
 *
 * 排序只用两个因子（log1p(触及次数) + 0.8×陈旧度）。原作者在约 38000 个已触及关键位上
 * 做过候选评分搜索：成交量剖面的「守住率差 +8.98pp、收益率差 -0.88pp」—— 它测的是
 * 「价格会停」，不是「进场能赚」，所以移出排序、单独作 pStall 输出。我们这边只做展示，
 * 两个都留着，界面上分开写清楚。
 *
 * 刻意没抄：它的概率模型 prob_models.json、评分标定表 score_calibration.json、复权口径、
 * A 股标的口径。这些依赖它自己的回测样本，搬进加密盘口是假精确。
 *
 * 因果性：所有输入只用截止当前 bar 的数据。ZigZag 一次性跑完整条序列，但每个枢轴带
 * confirmIdx（价格反向走出 k×ATR 的那一根），只允许用 confirmIdx <= 当前 的枢轴 ——
 * 等价于「在当前时刻实时算」，不碰未来数据。
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
  /** 区中枢 */
  price: number;
  zoneLow: number;
  zoneHigh: number;
  role: 'support' | 'resistance';
  /**
   * 排序分：log1p(触及次数) + 0.8×(1-最近性)。越大越该当关键位。
   * 这是「相对强度」，不是概率，别当成守住的可能性来读。
   */
  score: number;
  /** 触及后守住的比例（Wilson 下界，0-1） */
  holdRate: number;
  /** 历史触及事件数（同一次进入只算一次） */
  touches: number;
  /** 其中守住的次数 */
  holds: number;
  /** 越久没被碰过越强 = 1 - 最近性。从没碰过记 1 */
  stale: number;
  /**
   * 成交量剖面看「价格容易在这里停」的倾向（0 起，量纲大致 0-2，越大越容易停）。
   * 不参与排序 —— 原作者实测它「守住率高但收益率差」，是「会停」不是「能赚」。
   */
  pStall: number;
  /** 区宽 / ATR */
  widthAtr: number;
  /** 距现价百分比（中枢相对最新价，带符号） */
  distancePct: number;
  /** 距现价 / ATR */
  distAtr: number;
  /** 最近一次触及距今多少根 bar；从没碰过为 -1 */
  barsSinceTouch: number;
}

export interface LevelSet {
  levels: Level[];
  atr: number;
  last: number;
  /** 参与计算的窗口里最高 / 最低价 */
  rangeHigh: number;
  rangeLow: number;
  nearestSupport: Level | null;
  nearestResistance: Level | null;
  /** 实际回看的 bar 数 */
  lookback: number;
  /** 用到的已确认枢轴数，方便自查 */
  pivots: number;
}

export interface LevelOptions {
  /** 成交量剖面回看长度 */
  lookback?: number;
  /** 历史触及统计回看长度 */
  histLookback?: number;
  /** 枢轴回看长度 */
  pivotLookback?: number;
  /** 箱宽 = binAtr × ATR */
  binAtr?: number;
  /** 最小价格变动单位。传合约的 order_price_round；0 表示按收盘价估 */
  tick?: number;
  /** 成交量剖面半衰期（bar） */
  halfLife?: number;
  /** 枢轴半衰期（bar） */
  pivotHalfLife?: number;
  /** 枢轴确认阈值（ATR 倍数） */
  pivotK?: number;
  /** ATR 周期 */
  atrPeriod?: number;
  /** 收盘价堆积的核宽（ATR） */
  closeKernelAtr?: number;
  /** 枢轴堆积的核宽（ATR） */
  pivotKernelAtr?: number;
  /** 区宽夹逼（ATR 倍数） */
  widthMinAtr?: number;
  widthMaxAtr?: number;
  /** 同一条位最多离现价多远（ATR 倍数） */
  maxDistAtr?: number;
  /** NMS 间距（ATR 倍数） */
  nmsGapAtr?: number;
  /** 输出上限 */
  maxOut?: number;
  /** 每侧至少给几个候选（峰值不够时用次高点补齐） */
  fillQuotaPerSide?: number;
  /** 每侧先按定位面留几个，再去算昂贵的历史统计 */
  prefilterK?: number;
  /** 事件去重冷却（bar） */
  touchGap?: number;
  /** 触及后看多少根判断守住还是破位 */
  touchHoldBars?: number;
  /** 破位阈值（ATR 倍数） */
  touchBreakAtr?: number;
  /** 达标阈值（ATR 倍数） */
  touchTargetAtr?: number;
  /** 事件少于这个数时不给 Wilson 下界，直接给保守值 */
  minTouchEvents?: number;
}

const DEFAULTS: Required<LevelOptions> = {
  lookback: 250,
  histLookback: 750,
  pivotLookback: 500,
  binAtr: 0.25,
  tick: 0,
  halfLife: 60,
  pivotHalfLife: 120,
  pivotK: 2,
  atrPeriod: 14,
  closeKernelAtr: 0.3,
  pivotKernelAtr: 0.35,
  widthMinAtr: 0.3,
  widthMaxAtr: 1.2,
  maxDistAtr: 5,
  nmsGapAtr: 0.9,
  maxOut: 10,
  fillQuotaPerSide: 3,
  prefilterK: 8,
  touchGap: 5,
  touchHoldBars: 10,
  touchBreakAtr: 0.5,
  touchTargetAtr: 1,
  minTouchEvents: 2,
};

const LOG2 = Math.log(2);

// ---------- 基础工具 ----------

function median(x: number[]): number {
  if (x.length === 0) return 0;
  const s = [...x].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 逐根真实波幅 */
function trueRange(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i === 0) { out.push(b.high - b.low); continue; }
    const pc = bars[i - 1]!.close;
    out.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  return out;
}

/**
 * 因果 ATR 序列：第 i 个元素只用 0..i 的数据（滚动均值，和上游 data.atr_series 一致）。
 * 前 period 根用累计均值填充，不产生 NaN。
 */
export function atrSeries(bars: Bar[], period = 14): number[] {
  const tr = trueRange(bars);
  const out: number[] = new Array(tr.length).fill(0);
  const p = Math.max(1, Math.round(period));
  let run = 0;
  for (let i = 0; i < tr.length; i++) {
    run += tr[i]!;
    if (i < p) out[i] = run / (i + 1);
    else { run -= tr[i - p]!; out[i] = run / p; }
  }
  return out;
}

/** 最新一根的 ATR */
export function atr(bars: Bar[], period = 14): number {
  const s = atrSeries(bars, period);
  return s.length ? s[s.length - 1]! : 0;
}

// ---------- 分箱与剖面（上游 src/srlab/profile.py） ----------

/** 方向。整个服务端共用这一个定义 */
export type Direction = 'long' | 'short';

/** 分箱。导出只为自检脚本能直接验体积守恒 */
export interface Bins { p0: number; binW: number; nb: number }

export function makeBins(lo: number, hi: number, binW: number, maxBins = 2000): Bins {
  const span = Math.max(hi - lo, binW);
  let n = Math.ceil(span / binW) + 1;
  let w = binW;
  if (n > maxBins) { w = span / (maxBins - 1); n = maxBins; }
  return { p0: lo, binW: w, nb: n };
}

function binCenters(b: Bins): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.nb; i++) out.push(b.p0 + (i + 0.5) * b.binW);
  return out;
}

/** age=0 为最新一根，权重 1；age=halfLife 时权重 0.5 */
export function decayWeights(n: number, halfLife: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const age = n - 1 - i;
    out.push(halfLife > 0 ? Math.exp((-LOG2 * age) / halfLife) : 1);
  }
  return out;
}

/**
 * 体积守恒的成交量-价格剖面：每根 K 线的成交量在它覆盖的箱上均摊。
 * 差额数组 + 前缀和，O(n + nb)。上游实测旧做法（全额计入每个箱）会把隐含总量放大 15.8 倍。
 */
export function volumeProfile(h: number[], l: number[], w: number[], b: Bins): number[] {
  const diff = new Array(b.nb + 1).fill(0);
  for (let i = 0; i < h.length; i++) {
    const lo = clamp(Math.floor((l[i]! - b.p0) / b.binW), 0, b.nb - 1);
    const hi = Math.max(clamp(Math.floor((h[i]! - b.p0) / b.binW), 0, b.nb - 1), lo);
    const share = w[i]! / (hi - lo + 1);
    diff[lo] = diff[lo]! + share;
    diff[hi + 1] = diff[hi + 1]! - share;
  }
  const out: number[] = new Array(b.nb).fill(0);
  let run = 0;
  for (let i = 0; i < b.nb; i++) { run += diff[i]!; out[i] = run; }
  return out;
}

/** 点价格剖面：每个价格按高斯核撒到邻近箱（收盘价堆积、枢轴价堆积都用它） */
function pointProfile(price: number[], weight: number[], b: Bins, kernelBins: number): number[] {
  const out: number[] = new Array(b.nb).fill(0);
  for (let i = 0; i < price.length; i++) {
    const idx = clamp(Math.floor((price[i]! - b.p0) / b.binW), 0, b.nb - 1);
    out[idx] = out[idx]! + weight[i]!;
  }
  return kernelBins > 0 ? gaussianBlur(out, kernelBins) : out;
}

/** 一维高斯平滑，边界用截断归一化补偿被截掉的核质量 */
function gaussianBlur(x: number[], sigmaBins: number): number[] {
  if (sigmaBins <= 0 || x.length < 3) return x;
  const r = Math.max(1, Math.round(3 * sigmaBins));
  const kern: number[] = [];
  let sum = 0;
  for (let t = -r; t <= r; t++) {
    const v = Math.exp(-0.5 * (t / sigmaBins) ** 2);
    kern.push(v);
    sum += v;
  }
  for (let i = 0; i < kern.length; i++) kern[i] = kern[i]! / sum;
  const out: number[] = new Array(x.length).fill(0);
  const norm: number[] = new Array(x.length).fill(0);
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    let wacc = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      const wgt = kern[k + r]!;
      wacc += wgt;
      if (j >= 0 && j < x.length) acc += x[j]! * wgt;
    }
    out[i] = acc;
    norm[i] = wacc;
  }
  for (let i = 0; i < out.length; i++) out[i] = norm[i]! > 1e-12 ? out[i]! / norm[i]! : out[i]!;
  return out;
}

/**
 * 稳健标准化再压到 0-1：(x - median) / (1.4826×MAD) 过 logistic。
 * 把成交量剖面、枢轴剖面这些不同量纲的证据放到同一尺度上融合。
 */
function robustZ(x: number[]): number[] {
  if (x.length === 0) return x;
  const med = median(x);
  const scale = 1.4826 * median(x.map((v) => Math.abs(v - med)));
  if (scale < 1e-12) {
    let mx = 0;
    for (const v of x) mx = Math.max(mx, v);
    return x.map((v) => (mx > 1e-12 ? v / mx : 0));
  }
  return x.map((v) => 1 / (1 + Math.exp(-(v - med) / scale / 2)));
}

/** 极值点：不低于两侧邻居，再按高度降序做 minDistance 抑制。平台取中点 */
function findPeaks(y: number[], minDistance: number): number[] {
  const n = y.length;
  if (n < 3) return [];
  const cand: number[] = [];
  let i = 1;
  while (i < n - 1) {
    if (y[i]! >= y[i - 1]!) {
      let j = i;
      while (j < n - 1 && y[j + 1] === y[i]) j++;
      if (y[i]! >= y[Math.min(j + 1, n - 1)]!) cand.push((i + j) >> 1);
      i = j + 1;
    } else i++;
  }
  if (cand.length === 0) return [];
  const order = [...cand].sort((a, b) => y[b]! - y[a]!);
  const kept: number[] = [];
  for (const p of order) {
    if (kept.every((q) => Math.abs(p - q) >= minDistance)) kept.push(p);
  }
  return kept.sort((a, b) => a - b);
}

/** Wilson 得分区间下界（z=1.96，和上游 metrics.wilson 一致） */
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return Math.max(0, c - h);
}

/** 没有合约精度可用时按收盘价估一个最小变动价（上游 data.tick_size_guess） */
function tickGuess(closes: number[]): number {
  const px = median(closes);
  if (px <= 0) return 0.01;
  return px < 1000 ? 0.01 : Math.pow(10, Math.floor(Math.log10(px)) - 4);
}

// ---------- 因果 ZigZag 枢轴（上游 src/srlab/pivots.py） ----------

export interface Pivots {
  /** 枢轴所在 bar */
  idx: number[];
  price: number[];
  /** +1 高点（潜在阻力）/ -1 低点（潜在支撑） */
  kind: number[];
  /** 被确认的那一根（严格 > idx）：价格反向走出 k×ATR 的那一刻 */
  confirmIdx: number[];
  /** 从上一个枢轴到本枢轴的行程 / 当时 ATR，作为显著性 */
  legAtr: number[];
}

/**
 * ATR 阈值 ZigZag。kAtr = 2 表示价格从极值反向走出 2 倍 ATR 才确认该极值。
 *
 * 为什么要记 confirmIdx：传统分形枢轴天生带未来信息（判定第 i 根是摆动点要看到 i 之后）。
 * 这里对整条序列一次性跑 O(n)，但每个枢轴记下它被确认的那一根，t 时刻只用
 * confirmIdx <= t 的枢轴 —— 和「在 t 时刻实时算」等价，但省掉 O(n^2)。
 */
export function zigzag(bars: Bar[], atrArr: number[], kAtr = 2): Pivots {
  const n = bars.length;
  const out: Pivots = { idx: [], price: [], kind: [], confirmIdx: [], legAtr: [] };
  if (n < 3) return out;

  const push = (idx: number, price: number, kind: number, confirm: number) => {
    const prev = out.price.length ? out.price[out.price.length - 1]! : NaN;
    const leg = Number.isFinite(prev) ? Math.abs(price - prev) / Math.max(atrArr[idx] ?? 0, 1e-12) : 0;
    out.idx.push(idx);
    out.price.push(price);
    out.kind.push(kind);
    out.confirmIdx.push(confirm);
    out.legAtr.push(leg);
  };

  let hiI = 0;
  let hi = bars[0]!.high;
  let loI = 0;
  let lo = bars[0]!.low;
  let dir = 0; // 0 未定，+1 正在找高点，-1 正在找低点

  for (let i = 1; i < n; i++) {
    const b = bars[i]!;
    const thr = kAtr * Math.max(atrArr[i] ?? 0, 1e-12);
    if (dir >= 0 && b.high > hi) { hi = b.high; hiI = i; }
    if (dir <= 0 && b.low < lo) { lo = b.low; loI = i; }

    if (dir === 0) {
      if (hi - b.low >= thr) {
        push(hiI, hi, 1, i);
        dir = -1;
        lo = b.low;
        loI = i;
      } else if (b.high - lo >= thr) {
        push(loI, lo, -1, i);
        dir = 1;
        hi = b.high;
        hiI = i;
      }
      continue;
    }

    if (dir === 1) {
      if (hi - b.low >= thr) {
        push(hiI, hi, 1, i);
        dir = -1;
        lo = b.low;
        loI = i;
      }
    } else if (b.high - lo >= thr) {
      push(loI, lo, -1, i);
      dir = 1;
      hi = b.high;
      hiI = i;
    }
  }
  return out;
}

// ---------- 三个证据面 ----------

/**
 * 枢轴剖面：低点是潜在支撑、高点是潜在阻力，但破位后角色互换，
 * 所以两个面各自保留对方 40% 的贡献。
 */
function pivotProfiles(
  bars: Bar[], atrArr: number[], b: Bins, atrValue: number, p: Required<LevelOptions>,
): { sup: number[]; res: number[]; used: number } {
  const zeros = new Array(b.nb).fill(0);
  const zz = zigzag(bars, atrArr, p.pivotK);
  const t = bars.length - 1;
  const idx: number[] = [];
  const price: number[] = [];
  const kind: number[] = [];
  const wts: number[] = [];
  for (let i = 0; i < zz.idx.length; i++) {
    if (zz.confirmIdx[i]! > t) continue;           // 还没被确认，不能用
    if (zz.idx[i]! < t - p.pivotLookback) continue; // 太老
    const age = t - zz.idx[i]!;
    const rec = Math.exp((-LOG2 * age) / Math.max(p.pivotHalfLife, 1e-9));
    const sig = clamp(zz.legAtr[i]!, 0.5, 8);       // 形成这个枢轴的行程越大越显著
    idx.push(i);
    price.push(zz.price[i]!);
    kind.push(zz.kind[i]!);
    wts.push(rec * sig);
  }
  if (idx.length === 0) return { sup: zeros, res: zeros, used: 0 };

  const kb = Math.max(0.5, (p.pivotKernelAtr * atrValue) / b.binW);
  const loP: number[] = [];
  const loW: number[] = [];
  const hiP: number[] = [];
  const hiW: number[] = [];
  for (const i of idx) {
    if (kind[i] === -1) { loP.push(price[i]!); loW.push(wts[i]!); }
    else { hiP.push(price[i]!); hiW.push(wts[i]!); }
  }
  const supRaw = pointProfile(loP, loW, b, kb);
  const resRaw = pointProfile(hiP, hiW, b, kb);
  const sup = robustZ(supRaw.map((v, i) => v + 0.4 * resRaw[i]!));
  const res = robustZ(resRaw.map((v, i) => v + 0.4 * supRaw[i]!));
  return { sup, res, used: idx.length };
}

/**
 * 区宽：由证据面的局部离散度决定（半高宽），再夹到 [widthMin, widthMax]×ATR。
 * 上游实测旧做法给出的区宽是 2.2~5.7 ATR，那才是「高胜率」的来源 —— 区越宽当然越容易守住。
 */
function zoneBounds(
  surf: number[], px: number[], i: number, atrValue: number, p: Required<LevelOptions>,
): { lo: number; hi: number } {
  const med = median(surf);
  const thr = surf[i]! - 0.5 * (surf[i]! - med);
  let li = i;
  while (li > 0 && surf[li - 1]! >= thr) li--;
  let ri = i;
  while (ri < surf.length - 1 && surf[ri + 1]! >= thr) ri++;
  let half = Math.max((px[ri]! - px[li]!) / 2, 0);
  half = clamp(half, (p.widthMinAtr * atrValue) / 2, (p.widthMaxAtr * atrValue) / 2);
  const c = px[i]!;
  return { lo: c - half, hi: c + half };
}

/**
 * 历史触及统计。返回守住率（Wilson 下界）、事件数、守住数、距今多少根。
 *
 * 与「数假突破」的差别：
 *   - 同一次进入区间只算一次事件（冷却 touchGap 根）
 *   - 方向校验：支撑要求上一根收盘在区上方（自上而下测试），阻力反之
 *   - 阈值 ATR 化：破位 = 收盘越过区外 break×ATR(当时)，达标 = 反向走出 target×ATR
 *   - 样本不足时给保守下界 0.25，而不是 0 或者虚高的比例
 */
function touchStats(
  bars: Bar[], atrArr: number[], zlo: number, zhi: number,
  role: 'support' | 'resistance', histLo: number, p: Required<LevelOptions>,
): { holdRate: number; events: number; holds: number; sinceTouch: number } {
  const none = { holdRate: 0, events: 0, holds: 0, sinceTouch: -1 };
  const hiEnd = bars.length - 1;   // 不含当前这根
  if (hiEnd - histLo < 30) return none;

  const n = hiEnd - histLo;
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = bars[histLo + i]!;
    h.push(b.high);
    l.push(b.low);
    c.push(b.close);
  }

  const inz: number[] = [];
  let lastTouch = -1;
  for (let j = 0; j < n; j++) {
    const hit = l[j]! <= zhi && h[j]! >= zlo;
    if (hit) lastTouch = j;
    if (!hit) continue;
    const prev = j === 0 ? c[0]! : c[j - 1]!;
    if (role === 'support' ? prev > zhi : prev < zlo) inz.push(j);
  }
  if (inz.length === 0) return { ...none, sinceTouch: lastTouch < 0 ? -1 : n - 1 - lastTouch };

  // 事件去重
  const events: number[] = [];
  let last = -1e9;
  for (const j of inz) {
    if (j - last >= p.touchGap) { events.push(j); last = j; }
  }

  let holds = 0;
  let breaks = 0;
  for (const j of events) {
    const e2 = Math.min(j + p.touchHoldBars, n - 1);
    if (e2 <= j) continue;
    const a = Math.max(atrArr[histLo + j] ?? 0, 1e-12);
    let brk = -1;
    let goal = -1;
    for (let k = j; k <= e2; k++) {
      if (role === 'support') {
        if (brk < 0 && c[k]! < zlo - p.touchBreakAtr * a) brk = k;
        if (goal < 0 && h[k]! >= zhi + p.touchTargetAtr * a) goal = k;
      } else {
        if (brk < 0 && c[k]! > zhi + p.touchBreakAtr * a) brk = k;
        if (goal < 0 && l[k]! <= zlo - p.touchTargetAtr * a) goal = k;
      }
    }
    if (brk < 0 && goal < 0) continue;
    if (goal < 0) breaks++;
    else if (brk < 0 || goal <= brk) holds++;
    else breaks++;
  }

  const tot = holds + breaks;
  const sinceTouch = lastTouch < 0 ? -1 : n - 1 - lastTouch;
  if (tot < p.minTouchEvents) return { holdRate: 0.25, events: tot, holds, sinceTouch };
  return { holdRate: wilsonLower(holds, tot), events: tot, holds, sinceTouch };
}

// ---------- 候选生成 ----------

/**
 * 候选 = 定位面上的极值点。极值不够时用满足间距的次高点补齐到 quota 个：
 * 上游的教训是每侧只产 1~2 个位时，和「每侧固定 3 个」的对照组没法公平比较。
 */
function candidates(
  loc: number[], px: number[], price: number, role: 'support' | 'resistance',
  atrValue: number, minD: number, p: Required<LevelOptions>,
): number[] {
  const ok = (i: number): boolean => {
    const c = px[i]!;
    if (role === 'support' ? c >= price : c <= price) return false;
    return Math.abs(c - price) / atrValue <= p.maxDistAtr;
  };
  const chosen = findPeaks(loc, minD)
    .filter(ok)
    .sort((a, b) => loc[b]! - loc[a]!)
    .slice(0, p.prefilterK);
  if (chosen.length >= p.fillQuotaPerSide) return chosen;
  const order = loc.map((_, i) => i).sort((a, b) => loc[b]! - loc[a]!);
  for (const i of order) {
    if (chosen.length >= p.fillQuotaPerSide) break;
    if (!ok(i) || chosen.includes(i)) continue;
    if (chosen.every((j) => Math.abs(i - j) >= minD)) chosen.push(i);
  }
  return chosen;
}

// ---------- 主流程 ----------

export function detectLevels(input: Bar[], opts: LevelOptions = {}): LevelSet {
  const p: Required<LevelOptions> = { ...DEFAULTS, ...opts };
  const n = input.length;
  const last = n ? input[n - 1]!.close : 0;
  const base: LevelSet = {
    levels: [], atr: 0, last, rangeHigh: 0, rangeLow: 0,
    nearestSupport: null, nearestResistance: null, lookback: n, pivots: 0,
  };
  if (n < 30) {
    if (n) base.atr = atr(input, p.atrPeriod);
    return base;
  }

  const atrArr = atrSeries(input, p.atrPeriod);
  const atrValue = Math.max(atrArr[n - 1] ?? 0, 1e-12);

  const w = Math.min(p.lookback, n);
  const win = input.slice(n - w);
  const h = win.map((b) => b.high);
  const l = win.map((b) => b.low);
  const c = win.map((b) => b.close);
  const v = win.map((b) => b.volume);
  let winLo = Infinity;
  let winHi = -Infinity;
  for (const b of win) { winLo = Math.min(winLo, b.low); winHi = Math.max(winHi, b.high); }

  const tick = p.tick > 0 ? p.tick : tickGuess(c);
  const binW = Math.max(tick, p.binAtr * atrValue);
  const bins = makeBins(winLo - binW, winHi + binW, binW);
  if (bins.nb < 8) {
    return { ...base, atr: atrValue, rangeHigh: winHi, rangeLow: winLo };
  }

  const px = binCenters(bins);
  const dw = decayWeights(w, p.halfLife);
  const vw = v.map((x, i) => x * dw[i]!);
  const kernel = Math.max(0.5, (p.closeKernelAtr * atrValue) / bins.binW);
  // 证据 1：成交量剖面（体积守恒 + 时间衰减）
  const vp = robustZ(gaussianBlur(volumeProfile(h, l, vw, bins), kernel));
  // 证据 2：收盘价堆积
  const cp = robustZ(pointProfile(c, vw, bins, kernel));
  // 证据 3：枢轴聚集
  const pv = pivotProfiles(input, atrArr, bins, atrValue, p);

  const minD = Math.max(1, Math.round((p.nmsGapAtr * atrValue) / bins.binW));
  const histLo = Math.max(0, n - p.histLookback);
  const out: Level[] = [];

  for (const role of ['support', 'resistance'] as const) {
    // 定位面：三个证据加权。它只决定「去哪里找」，不参与最终排序
    const surf = role === 'support' ? pv.sup : pv.res;
    const loc = px.map((_, i) => 1.0 * vp[i]! + 0.8 * cp[i]! + 1.6 * surf[i]!);

    for (const i of candidates(loc, px, last, role, atrValue, minD, p)) {
      const zone = zoneBounds(loc, px, i, atrValue, p);
      const ts = touchStats(input, atrArr, zone.lo, zone.hi, role, histLo, p);
      // 陈旧度：越久没被碰过越强。从没碰过记 1（上游实测方向和直觉相反）
      const stale = ts.sinceTouch < 0 ? 1 : 1 - Math.exp((-LOG2 * ts.sinceTouch) / 120);
      // 排序分：只有两个实测稳定的因子
      const score = Math.log1p(Math.max(ts.events, 0)) + 0.8 * stale;
      // 停滞倾向：不参与排序，只作展示（价格在这里容易停，不代表进场能赚）
      const pStall = 1.0 * vp[i]! + 0.8 * cp[i]! + 0.3 * ((zone.hi - zone.lo) / atrValue);
      out.push({
        price: px[i]!,
        zoneLow: zone.lo,
        zoneHigh: zone.hi,
        role,
        score,
        holdRate: ts.holdRate,
        touches: ts.events,
        holds: ts.holds,
        stale,
        pStall,
        widthAtr: (zone.hi - zone.lo) / atrValue,
        distancePct: ((px[i]! - last) / last) * 100,
        distAtr: (px[i]! - last) / atrValue,
        barsSinceTouch: ts.sinceTouch,
      });
    }
  }

  // 非极大值抑制：按分数保留，剔掉和已保留区太近的（避免输出一堆彼此重叠的同一条位）
  const gap = Math.max(p.nmsGapAtr * atrValue, 1e-12);
  const kept: Level[] = [];
  for (const lv of [...out].sort((a, b) => b.score - a.score)) {
    if (kept.length >= p.maxOut) break;
    if (kept.every((k) => Math.abs(lv.price - k.price) >= gap)) kept.push(lv);
  }

  // 角色按区间和现价的关系定一遍：整个区在下方才是支撑，跨着现价的按中枢判
  for (const lv of kept) {
    if (lv.zoneHigh < last) lv.role = 'support';
    else if (lv.zoneLow > last) lv.role = 'resistance';
    else lv.role = lv.price <= last ? 'support' : 'resistance';
  }

  const byDistance = (role: 'support' | 'resistance'): Level | null => {
    const pool = kept.filter((x) => x.role === role);
    if (pool.length === 0) return null;
    return pool.reduce((a, b) => (Math.abs(b.distAtr) < Math.abs(a.distAtr) ? b : a));
  };

  return {
    levels: kept,
    atr: atrValue,
    last,
    rangeHigh: winHi,
    rangeLow: winLo,
    nearestSupport: byDistance('support'),
    nearestResistance: byDistance('resistance'),
    lookback: w,
    pivots: pv.used,
  };
}
