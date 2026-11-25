
/**
 * 形态条件实验的共用框架。
 *
 * 基准不是「全部 K 线」，而是「同条件、同方向、同波动档、无形态」的 K 线。
 * 这样「形态在支撑位」比的是「同一支撑位上的随便一根」，而不是「全市场随便一根」。
 *
 * 条件由调用方注入：stateOf(ctx) 返回一个字符串（如 S/R/M、资金费档、流量档）。
 * 命中与基准走同一个 stateOf、同一套障碍和成本。
 */
import { loadDir, windows, atrSeries, ATR_PERIOD, TREND_PERIOD } from './pattern-core.ts';
import { smaSlopeSeries } from '../src/lib/candlestick/trend.js';
import { allPatterns, patternChain } from '../src/lib/candlestick/patternChain.js';
import { PATTERNS } from '../src/lib/patternCatalogue.ts';
import { getPatternMetadata } from '../src/lib/candlestick/patternMetadata.js';
import { expectedTrendDirection } from '../src/lib/candlestick/contextFit.js';

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Dir = 1 | -1;
export type BarrierOutcome = { pnl: number; win: number; timeout: number };

export const COST = 0.0014;
export const BARRIERS: [number, number][] = [[1, 1], [1.5, 1], [2, 1], [999, 2]];
export const HOLD_BARS = 20;
export const FOLDS = 3;
export const PAD = ATR_PERIOD + TREND_PERIOD + 32;

export interface StateCtx {
  bars: Bar[];
  i: number;
  atr: number[];
  atrPct: number[];
  volT: number[];
  iv: string;
  sym: string;
}
export type StateFn = (ctx: StateCtx) => string | null;

export interface Hit {
  id: string;
  dir: Dir;
  iv: string;
  sym: string;
  fold: number;
  idx: number;
  volT: number;
  atrPct: number;
  state: string;
  align: number;
  ret3: number;
  ret20: number;
  bar: Record<string, BarrierOutcome>;
}

export interface BaseAgg {
  n: number;
  n3: number;
  w3: number;
  ret3s: number;
  ret3n: number;
  ret20: number;
  n20: number;
  /** key = "tp:sl" */
  bar: Map<string, { n: number; nw: number; w: number; pnl: number }>;
}

export interface Dataset {
  hits: Hit[];
  /** key = iv|volT|dir|state */
  base: Map<string, BaseAgg>;
  stats: { rawHits: number; keptHits: number; series: number };
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function barrierAt(bars: Bar[], atr: number[], i: number, dir: Dir, tp: number, sl: number, hold = HOLD_BARS): BarrierOutcome | null {
  const c = bars[i]!.close;
  const a = atr[i]!;
  if (!(a > 0)) return null;
  const target = dir > 0 ? c + tp * a : c - tp * a;
  const stop = dir > 0 ? c - sl * a : c + sl * a;
  const end = Math.min(i + hold, bars.length - 1);
  for (let j = i + 1; j <= end; j += 1) {
    const hitTp = dir > 0 ? bars[j]!.high >= target : bars[j]!.low <= target;
    const hitSl = dir > 0 ? bars[j]!.low <= stop : bars[j]!.high >= stop;
    // 同一根两边都碰到：按最坏算，宁可低估
    if (hitTp && hitSl) return { pnl: -sl, win: 0, timeout: 0 };
    if (hitTp) return { pnl: tp, win: 1, timeout: 0 };
    if (hitSl) return { pnl: -sl, win: 0, timeout: 0 };
  }
  const exit = Math.min(i + hold, bars.length - 1);
  return { pnl: (dir * (bars[exit]!.close - c)) / a, win: 0, timeout: 1 };
}

/** 下一根开盘入场，止损 sl ATR，最多 hold 根；返回扣费后的净 ATR 与出场下标 */
export function tradeAt(
  bars: Bar[], atr: number[], i: number, dir: Dir, hold = HOLD_BARS, sl = 2, cost = COST,
): { pnl: number; exit: number } | null {
  if (i + 2 >= bars.length) return null;
  const a = atr[i]!;
  const entry = bars[i + 1]!.open;
  if (!(a > 0) || !(entry > 0)) return null;
  const stop = dir > 0 ? entry - sl * a : entry + sl * a;
  const exit = Math.min(i + 1 + hold, bars.length - 1);
  for (let j = i + 2; j <= exit; j += 1) {
    const hit = dir > 0 ? bars[j]!.low <= stop : bars[j]!.high >= stop;
    if (hit) return { pnl: -sl - cost / (a / entry), exit: j };
  }
  const pnl = (dir * (bars[exit]!.close - entry)) / a;
  return { pnl: pnl - cost / (a / entry), exit };
}

function baseOf(base: Map<string, BaseAgg>, key: string): BaseAgg {
  let b = base.get(key);
  if (!b) {
    b = { n: 0, n3: 0, w3: 0, ret3s: 0, ret3n: 0, ret20: 0, n20: 0, bar: new Map() };
    base.set(key, b);
  }
  return b;
}

export interface BuildOptions {
  cache: string;
  symbols: string[];
  intervals: string[];
  bars?: number;
  folds?: number;
  stateOf: StateFn;
  /** 只统计这些下标之后的命中；默认 0 */
  minIndex?: number;
}

export function buildDataset(opt: BuildOptions): Dataset {
  const folds = opt.folds ?? FOLDS;
  const limitBars = opt.bars ?? 12000;
  const minIndex = opt.minIndex ?? 0;
  const hits: Hit[] = [];
  const base = new Map<string, BaseAgg>();
  let seriesCount = 0;

  for (const iv of opt.intervals) {
    for (const sym of opt.symbols) {
      const bars = loadDir(opt.cache, sym, iv, limitBars) as Bar[];
      if (bars.length < 500) continue;
      seriesCount += 1;
      const atr = atrSeries(bars, ATR_PERIOD);
      const trend = smaSlopeSeries(bars, TREND_PERIOD);
      const atrPct = bars.map((b, i) => (Number.isFinite(atr[i]!) && b.close > 0 ? atr[i]! / b.close : NaN));
      const sorted = atrPct.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      const q1 = sorted[Math.floor(sorted.length / 3)]!;
      const q2 = sorted[Math.floor((sorted.length * 2) / 3)]!;
      const volT = atrPct.map((v) => (!Number.isFinite(v) ? -1 : v < q1 ? 0 : v < q2 ? 1 : 2));

      const wins = windows(bars.length, folds);
      if (!wins.length) continue;
      const firstTrain = wins[0]!.trainEnd;
      const lastEnd = wins[wins.length - 1]!.testEnd;

      // 命中：先用各折测试段扫出来，记下命中根；基准必须排除这些根，
      // 否则「形态在支撑位」是拿「包含形态自己的所有 K 线」当基准，效应被稀释。
      const local: Hit[] = [];
      const hitIdx = new Set<number>();
      for (let f = 0; f < wins.length; f += 1) {
        const win = wins[f]!;
        const fromPad = Math.max(0, win.trainEnd - PAD);
        const end = Math.min(bars.length, win.testEnd + HOLD_BARS);
        const slice = bars.slice(fromPad, end);
        if (slice.length < 100) continue;
        const results = patternChain(slice, allPatterns, {
          trendContext: { trendMethod: 'sma-slope', trendPeriod: TREND_PERIOD, resolveConflicts: false },
        }) as any[];
        for (const res of results) {
          const id = res.pattern as string;
          const info = PATTERNS[id];
          const meta = getPatternMetadata(id);
          if (!info || !meta || meta.direction === 'neutral') continue;
          const confirm = fromPad + Number(res.index) + info.span - 1;
          if (!(confirm >= win.trainEnd && confirm < win.testEnd)) continue;
          if (confirm + 3 >= bars.length || confirm < minIndex) continue;
          const a = atr[confirm]!;
          const close = bars[confirm]!.close;
          const t = volT[confirm]!;
          if (!(a > 0) || close <= 0 || t < 0) continue;
          const state = opt.stateOf({ bars, i: confirm, atr, atrPct, volT, iv, sym });
          if (!state) continue;
          const dir: Dir = meta.direction === 'bearish' ? -1 : 1;
          const slope = trend[confirm - 1];
          const expect = expectedTrendDirection(meta);
          const align = typeof slope === 'number' && Number.isFinite(slope) ? expect * slope : 0;
          const aPct = a / close;
          const ret3 = (dir * (bars[confirm + 3]!.close - close)) / close / aPct;
          const ret20 = confirm + 20 < bars.length && confirm + 20 < end
            ? (dir * (bars[confirm + 20]!.close - close)) / close / aPct : NaN;
          const bar: Record<string, BarrierOutcome> = {};
          for (const [tp, sl] of BARRIERS) {
            const o = barrierAt(bars, atr, confirm, dir, tp, sl);
            if (o) bar[tp + ':' + sl] = o;
          }
          local.push({ id, dir, iv, sym, fold: f, idx: confirm, volT: t, atrPct: aPct, state, align, ret3, ret20, bar });
          hitIdx.add(confirm);
        }
      }
      hits.push(...local);

      // 基准：测试段内、非命中根、两个方向、同 state 同波动档
      for (let i = Math.max(firstTrain, minIndex + 60); i < lastEnd; i += 1) {
        if (hitIdx.has(i)) continue;
        const t = volT[i]!;
        const aPct = atrPct[i]!;
        if (t < 0 || !(aPct > 0)) continue;
        const state = opt.stateOf({ bars, i, atr, atrPct, volT, iv, sym });
        if (!state) continue;
        for (const dir of [1, -1] as const) {
          const key = iv + '|' + t + '|' + dir + '|' + state;
          const b = baseOf(base, key);
          if (i + 3 < lastEnd) {
            const r3 = (dir * (bars[i + 3]!.close - bars[i]!.close)) / bars[i]!.close;
            b.ret3s += r3 / aPct;
            b.ret3n += 1;
            if (r3 !== 0) { b.n3 += 1; if (r3 > 0) b.w3 += 1; }
          }
          if (i + 20 < lastEnd) {
            b.ret20 += (dir * (bars[i + 20]!.close - bars[i]!.close)) / bars[i]!.close / aPct;
            b.n20 += 1;
          }
          b.n += 1;
          for (const [tp, sl] of BARRIERS) {
            const o = barrierAt(bars, atr, i, dir, tp, sl);
            if (!o) continue;
            const k = tp + ':' + sl;
            const cell = b.bar.get(k) ?? { n: 0, nw: 0, w: 0, pnl: 0 };
            cell.n += 1; cell.pnl += o.pnl;
            if (!o.timeout) { cell.nw += 1; if (o.win) cell.w += 1; }
            b.bar.set(k, cell);
          }
        }
      }
    }
  }

  // 同一序列、同一形态，3 根内的重复命中只留第一个
  const seen = new Map<string, number>();
  const kept: Hit[] = [];
  for (const h of [...hits].sort((a, b) => (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : a.iv < b.iv ? -1 : a.iv > b.iv ? 1 : a.fold - b.fold || a.idx - b.idx))) {
    const k = h.sym + '|' + h.iv + '|' + h.fold + '|' + h.id;
    const last = seen.get(k);
    if (last !== undefined && h.idx - last < 3) continue;
    seen.set(k, h.idx);
    kept.push(h);
  }
  return { hits: kept, base, stats: { rawHits: hits.length, keptHits: kept.length, series: seriesCount } };
}

export interface GroupAgg {
  n: number;
  matched: number;
  n3: number;
  w3: number;
  baseW3: number;
  ret3: number;
  ret20: number;
  n20: number;
  baseRet3: number;
  baseRet3n: number;
  baseRet20: number;
  baseRet20n: number;
  ret20s: number[];
  bar: Map<string, { n: number; nw: number; w: number; pnl: number; net: number; basePnl: number; baseNet: number }>;
  blocks: Map<string, { w: number; b: number; n: number; r20: number; b20: number; n20: number }>;
}

export function aggregate(hits: Hit[], base: Map<string, BaseAgg>): GroupAgg {
  const a: GroupAgg = {
    n: 0, matched: 0, n3: 0, w3: 0, baseW3: 0, ret3: 0, ret20: 0, n20: 0,
    baseRet3: 0, baseRet3n: 0, baseRet20: 0, baseRet20n: 0, ret20s: [],
    bar: new Map(), blocks: new Map(),
  };
  for (const h of hits) {
    a.n += 1;
    const b = base.get(h.iv + '|' + h.volT + '|' + h.dir + '|' + h.state);
    if (!b || b.n3 === 0) continue;
    a.matched += 1;
    const bw = b.w3 / b.n3;
    if (Number.isFinite(h.ret3)) {
      a.n3 += 1;
      if (h.ret3 > 0) a.w3 += 1;
      a.ret3 += h.ret3;
      a.baseW3 += bw;
    }
    if (b.ret3n > 0) { a.baseRet3 += b.ret3s / b.ret3n; a.baseRet3n += 1; }
    if (Number.isFinite(h.ret20)) { a.ret20 += h.ret20; a.n20 += 1; }
    if (b.n20 > 0) { a.baseRet20 += b.ret20 / b.n20; a.baseRet20n += 1; }
    const key = h.sym + '|' + h.iv + '|' + h.fold + '|' + Math.floor(h.idx / 50);
    const blk = a.blocks.get(key) ?? { w: 0, b: 0, n: 0, r20: 0, b20: 0, n20: 0 };
    if (Number.isFinite(h.ret3)) { blk.w += h.ret3 > 0 ? 1 : 0; blk.b += bw; blk.n += 1; }
    if (Number.isFinite(h.ret20) && b.n20 > 0) {
      a.ret20s.push(h.ret20);
      blk.r20 += h.ret20; blk.b20 += b.ret20 / b.n20; blk.n20 += 1;
    }
    a.blocks.set(key, blk);

    const costAtr = COST / h.atrPct;
    for (const [tp, sl] of BARRIERS) {
      const o = h.bar[tp + ':' + sl];
      const bb = b.bar.get(tp + ':' + sl);
      if (!o || !bb || bb.n === 0) continue;
      const k = tp + ':' + sl;
      const cell = a.bar.get(k) ?? { n: 0, nw: 0, w: 0, pnl: 0, net: 0, basePnl: 0, baseNet: 0 };
      cell.n += 1; cell.pnl += o.pnl; cell.net += o.pnl - costAtr;
      cell.basePnl += bb.pnl / bb.n; cell.baseNet += bb.pnl / bb.n - costAtr;
      if (!o.timeout) { cell.nw += 1; if (o.win) cell.w += 1; }
      a.bar.set(k, cell);
    }
  }
  return a;
}

/** 分块稳健 z：块内命中相关，不能按逐笔独立算 */
export function clusterZ(a: GroupAgg): number {
  const blocks = [...a.blocks.values()].filter((b) => b.n > 0);
  const C = blocks.length;
  const n = blocks.reduce((s, b) => s + b.n, 0);
  if (C < 2 || n === 0 || a.n3 === 0) return 0;
  const diffs = blocks.map((b) => b.w - b.b);
  const dbar = diffs.reduce((s, x) => s + x, 0) / n;
  let ss = 0;
  for (let i = 0; i < C; i += 1) {
    const resid = diffs[i]! - blocks[i]!.n * dbar;
    ss += resid * resid;
  }
  const v = (C / (C - 1)) * ss / (n * n);
  return v > 0 ? dbar / Math.sqrt(v) : 0;
}

export function ret20Z(a: GroupAgg): number {
  const blocks = [...a.blocks.values()].filter((b) => b.n20 > 0);
  const C = blocks.length;
  const n = blocks.reduce((s, b) => s + b.n20, 0);
  if (C < 2 || n === 0) return 0;
  const diffs = blocks.map((b) => b.r20 - b.b20);
  const dbar = diffs.reduce((s, x) => s + x, 0) / n;
  let ss = 0;
  for (let i = 0; i < C; i += 1) {
    const resid = diffs[i]! - blocks[i]!.n20 * dbar;
    ss += resid * resid;
  }
  const v = (C / (C - 1)) * ss / (n * n);
  return v > 0 ? dbar / Math.sqrt(v) : 0;
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export function line(label: string, a: GroupAgg): string {
  const win = a.n3 ? a.w3 / a.n3 : NaN;
  const baseWin = a.matched ? a.baseW3 / a.matched : NaN;
  const parts = [
    label,
    String(a.n),
    String(a.matched),
    (win * 100).toFixed(1),
    (baseWin * 100).toFixed(1),
    ((win - baseWin) * 100 >= 0 ? '+' : '') + ((win - baseWin) * 100).toFixed(1),
    clusterZ(a).toFixed(2),
    (a.ret3 / Math.max(1, a.n3)).toFixed(3),
    (a.ret20 / Math.max(1, a.n20)).toFixed(3),
    ((a.ret3 / Math.max(1, a.n3)) - (a.baseRet3 / Math.max(1, a.baseRet3n))).toFixed(3),
    ((a.ret20 / Math.max(1, a.n20)) - (a.baseRet20 / Math.max(1, a.baseRet20n))).toFixed(3),
    ret20Z(a).toFixed(2),
    (median(a.ret20s) || 0).toFixed(3),
    (a.ret20s.length ? (a.ret20s.filter((x) => x > 0).length / a.ret20s.length * 100).toFixed(1) : '—'),
  ];
  for (const [tp, sl] of BARRIERS) {
    const b = a.bar.get(tp + ':' + sl);
    if (!b || b.n === 0) { parts.push('—'); continue; }
    const bwin = b.nw ? (b.w / b.nw) * 100 : NaN;
    const net = b.net / b.n;
    const bnet = b.baseNet / b.n;
    // 999 档没有止盈，胜率那格写「时间」，免得把 0% 误读成「一次没赢」
    const head = tp >= 100 ? '时间' : bwin.toFixed(1) + '%';
    parts.push(head + '/' + (net >= 0 ? '+' : '') + net.toFixed(2) + ' (基准' + (bnet >= 0 ? '+' : '') + bnet.toFixed(2) + ')');
  }
  return parts.join('\t');
}

export const HEADER = '分组\tN\t匹配N\t3根胜率%\t基准%\t增量pp\tz\t3根ATR\t20根ATR\t3根超额\t20根超额\t20根z\t20根中位\t20根>0%\t1:1\t1.5:1\t2:1\t2ATR止损+时间';
