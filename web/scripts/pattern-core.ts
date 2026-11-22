/**
 * 形态统计的共用部分：取数、指标、把一批 K 线聚成「形态 → 胜率/增量」。
 *
 * 放成模块是为了让两个脚本用同一套口径，又不至于互相 import：
 *   - scripts/pattern-stats.ts    出展示用的统计表（滚动多折，只在训练段选、测试段验）
 *   - scripts/check-patterns.ts   自检（统计表能对上、口径自洽）
 *
 * 这里刻意不放展示门槛：门槛是「选」的逻辑，属于统计脚本；本模块只负责「量」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bar } from '../../web/src/lib/api.ts';
import { PATTERNS } from '../../web/src/lib/patternCatalogue.ts';
import { allPatterns, patternChain } from '../../web/src/lib/candlestick/patternChain.js';
import { getPatternMetadata } from '../../web/src/lib/candlestick/patternMetadata.js';
import { smaSlopeSeries } from '../../web/src/lib/candlestick/trend.js';
import { expectedTrendDirection } from '../../web/src/lib/candlestick/contextFit.js';

/** 前向收益的持有根数。主口径 3 根：反转形态常在 3~5 根里走完，1 根太噪、5 根掺进别的行情 */
export const HORIZONS = [1, 3, 5] as const;
export const PRIMARY = 3;
export const ATR_PERIOD = 14;
export const TREND_PERIOD = 10;

/**
 * 展示门槛：
 *   n ≥ MIN_SAMPLES      样本太少不下结论
 *   excess ≥ MIN_EXCESS  至少比基准高 2 个百分点
 *   BH 校正后 q ≤ FDR    同一张表里的多重检验要一起校正
 */
export const MIN_SAMPLES = 100;
export const MIN_EXCESS = 0.02;
export const FDR = 0.1;
export const TIER3_Q = 0.01;
export const TIER2_Q = 0.05;

// ---------- 取数 ----------
type RawGate = { t: number; o: string; h: string; l: string; c: string; v: number | string; sum?: string };

/** Gate 对象、Binance 数组、本脚本自己的缓存，三种形状都认 */
export function normalize(raw: unknown): Bar[] {
  const rows = raw as unknown[];
  const out: Bar[] = [];
  for (const r of rows) {
    if (Array.isArray(r)) {
      if (r.length < 5) continue;
      out.push({
        time: Math.floor(Number(r[0]) / 1000),
        open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
        volume: Number(r[5] ?? 0),
      });
      continue;
    }
    const c = r as RawGate & { open?: number; time?: number };
    if (!c || (c.o === undefined && c.open === undefined)) continue;
    out.push(c.o !== undefined
      ? { time: Number(c.t), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.sum ?? c.v ?? 0) }
      : { time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume ?? 0) });
  }
  out.sort((a, b) => a.time - b.time);
  // 分页会带回边界那一根，按时间去重
  return out.filter((b, i) => i === 0 || b.time !== out[i - 1]!.time);
}

export function loadDir(dir: string, contract: string, interval: string, want: number): Bar[] {
  const file = join(dir, contract + '_' + interval + '.json');
  if (!existsSync(file)) return [];
  return normalize(JSON.parse(readFileSync(file, 'utf8'))).slice(-want);
}

export async function fetchGate(contract: string, interval: string, want: number): Promise<Bar[]> {
  let bars: Bar[] = [];
  let guard = 0;
  while (bars.length < want && guard < 8) {
    guard += 1;
    const oldest = bars[0]?.time;
    const url = 'https://api.gateio.ws/api/v4/futures/usdt/candlesticks'
      + '?contract=' + encodeURIComponent(contract) + '&interval=' + interval + '&limit=2000'
      + (oldest ? '&to=' + oldest : '');
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const page = normalize(await res.json());
        if (page.length === 0) { ok = true; break; }
        const seen = new Set(bars.map((b) => b.time));
        const add = page.filter((b) => !seen.has(b.time));
        bars = [...add, ...bars].sort((a, b) => a.time - b.time);
        ok = true;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!ok) break;
  }
  return bars.slice(-want);
}

// ---------- 指标 ----------
export function atrSeries(bars: Bar[], period: number): number[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i]!;
    const prev = bars[i - 1];
    tr.push(prev ? Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)) : b.high - b.low);
  }
  const out = new Array<number>(bars.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < tr.length; i += 1) {
    sum += tr[i]!;
    if (i >= period) sum -= tr[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export const quantile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))]!;

// ---------- 累积器 ----------
export interface Acc {
  n: number;
  wins: number[];
  edges: number[];
}
export const newAcc = (): Acc => ({ n: 0, wins: HORIZONS.map(() => 0), edges: HORIZONS.map(() => 0) });

export interface Bucket {
  /** 基准的原始计数，最后再除 —— 存比率再反推次数会累积误差 */
  longWins: number[];
  shortWins: number[];
  baseCount: number[];
  patterns: Map<string, Acc>;
  aligns: number[];
  bars: number;
  firstTime: number;
  lastTime: number;
}
export const newBucket = (): Bucket => ({
  longWins: HORIZONS.map(() => 0),
  shortWins: HORIZONS.map(() => 0),
  baseCount: HORIZONS.map(() => 0),
  patterns: new Map(),
  aligns: [],
  bars: 0,
  firstTime: 0,
  lastTime: 0,
});
export const baseLong = (b: Bucket): number[] => b.baseCount.map((c, i) => (c > 0 ? b.longWins[i]! / c : NaN));
export const baseShort = (b: Bucket): number[] => b.baseCount.map((c, i) => (c > 0 ? b.shortWins[i]! / c : NaN));

/**
 * 把一段 K 线的某个区间喂进桶里：基准、趋势对齐度、各形态命中。
 *
 * `from` / `to` 是**全局**下标（相对传进来的 bars），只统计确认根落在 [from, to) 的命中、
 * 以及落在这个区间里的基准样本。`horizonEnd` 是前向收益允许看到的最远下标 ——
 * 训练段必须把它设成训练段的结束点，否则边界那几根会用测试段的价格算出收益，
 * 那就算偷看了未来。默认等于 bars.length（不限制）。
 *
 * 三个下标分开，是因为滚动多折里它们是三个不同的数：
 *   · 训练段末尾要带一段历史给趋势上下文用，但收益不能看过去；
 *   · 测试段要从起点之后才算命中，但 ATR 和 SMA 需要起点之前的历史。
 */
export function feed(bucket: Bucket, bars: Bar[], from = 0, to = bars.length, horizonEnd = bars.length): void {
  const lo = Math.max(0, from);
  const hi = Math.min(to, bars.length);
  if (hi <= lo) return;
  bucket.bars += hi - lo;
  bucket.firstTime = bucket.firstTime ? Math.min(bucket.firstTime, bars[lo]!.time) : bars[lo]!.time;
  bucket.lastTime = Math.max(bucket.lastTime, bars[hi - 1]!.time);

  const atr = atrSeries(bars, ATR_PERIOD);
  const trend = smaSlopeSeries(bars, TREND_PERIOD);
  const limit = Math.min(horizonEnd, bars.length);

  // 基准：区间内每一根都算「随便做多」「随便做空」各自对不对
  for (let i = lo; i < hi; i += 1) {
    for (let hi2 = 0; hi2 < HORIZONS.length; hi2 += 1) {
      const h = HORIZONS[hi2]!;
      if (i + h >= limit) continue;
      const r = (bars[i + h]!.close - bars[i]!.close) / bars[i]!.close;
      if (r === 0) continue;
      bucket.baseCount[hi2]! += 1;
      if (r > 0) bucket.longWins[hi2]! += 1;
      if (r < 0) bucket.shortWins[hi2]! += 1;
    }
  }

  const results = patternChain(bars, allPatterns, {
    trendContext: { trendMethod: 'sma-slope', trendPeriod: TREND_PERIOD, resolveConflicts: false },
  }) as any[];

  for (const res of results) {
    const id = res.pattern as string;
    const info = PATTERNS[id];
    const meta = getPatternMetadata(id);
    if (!info || !meta) continue;
    // 没有方向的形态（十字星、纺锤线、无方向的实体线）不参与统计：占样本却没方向
    if (meta.direction === 'neutral') continue;
    const expected = expectedTrendDirection(meta);
    const slope = trend[Number(res.index) - 1];
    const startIdx = Number(res.index);
    if (startIdx >= lo && startIdx < hi && expected !== 0 && typeof slope === 'number' && Number.isFinite(slope)) {
      bucket.aligns.push(expected * slope);
    }

    const confirm = Number(res.index) + info.span - 1;
    if (!Number.isFinite(confirm) || confirm < 1) continue;
    // 只统计确认根落在区间里的命中：训练段和测试段因此完全不重叠
    if (confirm < lo || confirm >= hi) continue;
    const a = atr[confirm];
    const close = bars[confirm]!.close;
    if (!Number.isFinite(a) || a <= 0 || close <= 0) continue;
    let acc = bucket.patterns.get(id);
    if (!acc) { acc = newAcc(); bucket.patterns.set(id, acc); }
    let counted = false;
    for (let hi = 0; hi < HORIZONS.length; hi += 1) {
      const h = HORIZONS[hi]!;
      if (confirm + h >= limit) continue;
      const r = (bars[confirm + h]!.close - close) / close;
      const signed = meta.direction === 'bearish' ? -r : r;
      acc.wins[hi]! += signed > 0 ? 1 : 0;
      // 单笔贡献上限 10 倍 ATR：低波动段偶尔会有一根 ATR 极小的，不夹住均值会被它拉跑
      const edge = Math.max(-10, Math.min(10, signed / (a / close)));
      acc.edges[hi]! += edge;
      counted = true;
    }
    if (counted) acc.n += 1;
  }
}

/** 两个桶合并（滚动多折时把各折的测试段拼起来） */
export function mergeBuckets(target: Bucket, src: Bucket): void {
  for (let i = 0; i < HORIZONS.length; i += 1) {
    target.longWins[i]! += src.longWins[i]!;
    target.shortWins[i]! += src.shortWins[i]!;
    target.baseCount[i]! += src.baseCount[i]!;
  }
  target.aligns.push(...src.aligns);
  target.bars += src.bars;
  target.firstTime = target.firstTime ? Math.min(target.firstTime, src.firstTime || Infinity) : src.firstTime;
  target.lastTime = Math.max(target.lastTime, src.lastTime);
  for (const [id, acc] of src.patterns) {
    let cur = target.patterns.get(id);
    if (!cur) { cur = newAcc(); target.patterns.set(id, cur); }
    cur.n += acc.n;
    for (let hi = 0; hi < HORIZONS.length; hi += 1) {
      cur.wins[hi]! += acc.wins[hi]!;
      cur.edges[hi]! += acc.edges[hi]!;
    }
  }
}

// ---------- 显著性 ----------
/** 标准正态的右尾概率，够用就行（Abramowitz-Stegun 7.1.26 的 erf 近似） */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
export const pRight = (z: number): number => 0.5 * (1 - erf(z / Math.SQRT2));

export interface Row {
  id: string;
  acc: Acc;
  win: number;
  base: number;
  excess: number;
  z: number;
  p: number;
  q: number;
  edgeAtr: number;
  winByHorizon: number[];
}

/** 桶 → 每个形态一行。applyFdr 决定要不要在这张表内部做 BH 校正 */
export function rowsOf(bucket: Bucket, applyFdr = true): Row[] {
  const primaryIdx = HORIZONS.indexOf(PRIMARY);
  const longs = baseLong(bucket);
  const shorts = baseShort(bucket);
  const rows: Row[] = [];
  for (const [id, acc] of bucket.patterns) {
    const meta = getPatternMetadata(id);
    const base = meta?.direction === 'bearish' ? shorts[primaryIdx]! : longs[primaryIdx]!;
    if (!Number.isFinite(base)) continue;
    const win = acc.n > 0 ? acc.wins[primaryIdx]! / acc.n : 0;
    const z = acc.n > 0 && base > 0 && base < 1 ? (win - base) / Math.sqrt((base * (1 - base)) / acc.n) : 0;
    rows.push({
      id, acc, win, base,
      excess: win - base,
      z,
      p: pRight(z),
      q: 1,
      edgeAtr: acc.n > 0 ? acc.edges[primaryIdx]! / acc.n : 0,
      winByHorizon: HORIZONS.map((_, hi) => (acc.n > 0 ? acc.wins[hi]! / acc.n : 0)),
    });
  }
  if (applyFdr && rows.length > 0) {
    // Benjamini-Hochberg：按 p 升序，q(i) = min_{k≥i} p(k) × m / k
    const byP = [...rows].sort((a, b) => a.p - b.p);
    const m = byP.length;
    let running = 1;
    for (let i = byP.length - 1; i >= 0; i -= 1) {
      const r = byP[i]!;
      running = Math.min(running, (r.p * m) / (i + 1));
      r.q = running;
    }
  }
  return rows;
}

export function tierOf(row: Row): 0 | 1 | 2 | 3 {
  if (row.acc.n < MIN_SAMPLES || row.excess < MIN_EXCESS) return 0;
  if (row.q <= TIER3_Q) return 3;
  if (row.q <= TIER2_Q) return 2;
  if (row.q <= FDR) return 1;
  return 0;
}


// ---------- 滚动多折 ----------
// ---------- 分折 ----------
/** 扩张窗口：训练段从 0 开始，每折往后多给一截，测试段紧随其后 */
export interface Window { trainEnd: number; testEnd: number }

export function windows(n: number, folds: number): Window[] {
  const list: Window[] = [];
  // 第一折的训练段占一半，剩下的均匀切给各折的测试段
  const first = Math.floor(n / 2);
  const step = Math.floor((n - first) / folds);
  if (step < 100) return [];
  for (let f = 0; f < folds; f += 1) {
    const trainEnd = first + step * f;
    const testEnd = Math.min(n, trainEnd + step);
    if (testEnd - trainEnd < 50) continue;
    list.push({ trainEnd, testEnd });
  }
  return list;
}

export interface Series { contract: string; interval: string; bars: Bar[] }

export interface FoldReport {
  fold: number;
  trainBars: number;
  testBars: number;
  /** 训练段上过门槛的形态数 */
  picked: number;
  /** 这些形态在测试段上的增量（按样本加权） */
  testExcess: number;
  /** 这批形态在训练段上的增量，用来和测试段对比：掉得越多越像过拟合 */
  trainExcess: number;
  detail: string;
}

/**
 * 滚一遍所有的序列，返回「各折测试段合并」的桶。
 *
 * 每一折：
 *   · 训练段 [0, trainEnd)：形态判定可以用全部历史（ATR、SMA 都要往回看），
 *     但前向收益只能看到 trainEnd —— 边界那几根拿不到之后的行情，不算收益，也就不会进样本；
 *   · 训练段内部跑 BH 校正，得出「这一折选中了哪些形态」；
 *   · 测试段 [trainEnd, testEnd)：命中必须确认在测试段内，收益也只能看到 testEnd；
 *   · 各折测试段合并 —— 下面这张表就是「从没见过的那部分数据」上的表现。
 */
export function walkForward(series: Series[], folds: number): { test: Bucket; reports: FoldReport[] } {
  const test = newBucket();
  const reports: FoldReport[] = [];
  // 每一折的测试段都单独建桶，最后再按形态合并（不能共用一个桶，否则各折的基准会串）
  const hLast = HORIZONS[HORIZONS.length - 1]!;

  for (let f = 0; f < folds; f += 1) {
    const train = newBucket();
    const perSeries: { s: Series; win: Window }[] = [];
    let trainBars = 0;
    let testBars = 0;

    for (const s of series) {
      const win = windows(s.bars.length, folds)[f];
      if (!win) continue;
      perSeries.push({ s, win });
      trainBars += win.trainEnd;
      testBars += win.testEnd - win.trainEnd;
    }
    if (perSeries.length === 0) continue;

    // 训练段：可以看到整段历史，收益只到 trainEnd
    for (const { s, win } of perSeries) {
      const end = Math.min(s.bars.length, win.trainEnd + hLast);
      feed(train, s.bars.slice(0, end), 0, win.trainEnd);
    }

    const trainRows = rowsOf(train);
    const picked = trainRows.filter((r) => tierOf(r) >= 1);
    const pickedIds = new Set(picked.map((r) => r.id));

    // 测试段：命中必须落在测试段内，收益只到 testEnd。
    // 起点往前多带一段历史，ATR / SMA / 趋势上下文都要用到，但命中不会早于起点。
    const pad = ATR_PERIOD + TREND_PERIOD + 32;
    const seg = newBucket();
    for (const { s, win } of perSeries) {
      const fromPad = Math.max(0, win.trainEnd - pad);
      const end = Math.min(s.bars.length, win.testEnd + hLast);
      feed(seg, s.bars.slice(fromPad, end), win.trainEnd - fromPad, win.testEnd - fromPad);
    }

    // 只把训练段选中的形态并进汇总：测试段是给「选」做检验，不是重新选一遍
    const testRowMap = new Map(rowsOf(seg, false).map((r) => [r.id, r]));
    // 基准和所有形态一起并进汇总（界面上每个形态都要有对照，不能只留选中的那些）
    for (let hi = 0; hi < HORIZONS.length; hi += 1) {
      test.longWins[hi]! += seg.longWins[hi]!;
      test.shortWins[hi]! += seg.shortWins[hi]!;
      test.baseCount[hi]! += seg.baseCount[hi]!;
    }
    for (const row of testRowMap.values()) {
      const cur = test.patterns.get(row.id);
      if (cur) {
        cur.n += row.acc.n;
        for (let hi = 0; hi < HORIZONS.length; hi += 1) {
          cur.wins[hi]! += row.acc.wins[hi]!;
          cur.edges[hi]! += row.acc.edges[hi]!;
        }
      } else {
        const acc = newAcc();
        acc.n = row.acc.n;
        for (let hi = 0; hi < HORIZONS.length; hi += 1) {
          acc.wins[hi] = row.acc.wins[hi]!;
          acc.edges[hi] = row.acc.edges[hi]!;
        }
        test.patterns.set(row.id, acc);
      }
    }
    test.bars += testBars;

    // 训练段选中的那些，在测试段还站不站得住 —— 闭环唯一要回答的就是这个
    let pickedN = 0;
    let pickedExcess = 0;
    let pickedTrainExcess = 0;
    for (const id of pickedIds) {
      const row = testRowMap.get(id);
      if (!row) continue;
      pickedN += row.acc.n;
      pickedExcess += row.excess * row.acc.n;
      const tr = trainRows.find((r) => r.id === id);
      pickedTrainExcess += (tr?.excess ?? 0) * row.acc.n;
    }

    reports.push({
      fold: f + 1,
      trainBars,
      testBars,
      picked: pickedIds.size,
      testExcess: pickedN > 0 ? pickedExcess / pickedN : 0,
      trainExcess: pickedN > 0 ? pickedTrainExcess / pickedN : 0,
      detail: pickedIds.size > 0 ? [...pickedIds].join(',') : '（无）',
    });
  }

  return { test, reports };
}

