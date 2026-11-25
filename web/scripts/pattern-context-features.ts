
/**
 * 三条路各自的条件状态：关键位（代理/引擎）、资金费、订单流。
 * 只负责「把数据读成 stateOf」，统计和判定在 pattern-context-core.ts。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hit, StateFn } from './pattern-context-core.ts';

// ---------- 关键位代理 ----------

/** 前 N 根的高低点当支撑/阻力；价格在低点上方 near ATR 内 = S，高点下方 = R */
export function levelProxyState(lookback = 20, near = 0.5): StateFn {
  return (ctx) => {
    const { bars, i, atr } = ctx;
    if (i < lookback) return null;
    const a = atr[i]!;
    if (!(a > 0)) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - lookback; j < i; j += 1) {
      const b = bars[j]!;
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
    }
    if (!(hi > lo)) return null;
    const c = bars[i]!.close;
    const dS = (c - lo) / a;
    const dR = (hi - c) / a;
    if (dS >= 0 && dS <= near) return 'S';
    if (dR >= 0 && dR <= near) return 'R';
    if (dS < 0 && dS >= -near) return 'B';
    if (dR < 0 && dR >= -near) return 'A';
    return 'M';
  };
}

// ---------- 真实引擎关键位 ----------

type Zone = { center: number; low: number; high: number; type: 'support' | 'resistance'; edge: number };
type Slice = { from: number; to: number; zones: Zone[] };
type Timeline = { slices: Slice[] };

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function loadEngineTimelines(dir: string, symbols: string[], intervals: string[]): Map<string, Timeline | null> {
  const map = new Map<string, Timeline | null>();
  for (const iv of intervals) {
    for (const sym of symbols) map.set(sym + '|' + iv, readJson<Timeline>(join(dir, sym + '_' + iv + '.json')));
  }
  return map;
}

function sliceAt(slices: Slice[], i: number): Slice | null {
  let lo = 0;
  let hi = slices.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = slices[mid]!;
    if (i < s.from) hi = mid - 1;
    else if (i > s.to) lo = mid + 1;
    else return s;
  }
  return null;
}

export function engineState(timelines: Map<string, Timeline | null>, near = 0.5): StateFn {
  return (ctx) => {
    const tl = timelines.get(ctx.sym + '|' + ctx.iv);
    if (!tl) return null;
    const s = sliceAt(tl.slices, ctx.i);
    if (!s) return null;
    const a = ctx.atr[ctx.i]!;
    const c = ctx.bars[ctx.i]!.close;
    if (!(a > 0)) return null;
    let sup: Zone | null = null;
    let res: Zone | null = null;
    for (const z of s.zones) {
      if (z.type === 'support' && z.center <= c) {
        if (!sup || z.center > sup.center) sup = z;
      } else if (z.type === 'resistance' && z.center >= c) {
        if (!res || z.center < res.center) res = z;
      }
    }
    const dS = sup ? (c - sup.center) / a : NaN;
    const dR = res ? (res.center - c) / a : NaN;
    const nearS = Number.isFinite(dS) && dS >= -near && dS <= near;
    const nearR = Number.isFinite(dR) && dR >= -near && dR <= near;
    if (nearS && (!nearR || Math.abs(dS) <= Math.abs(dR))) return dS >= 0 ? 'S' : 'B';
    if (nearR) return dR >= 0 ? 'R' : 'A';
    return 'M';
  };
}

// ---------- 资金费 ----------

type Funding = { t: number; r: number };

export function fundingState(gateDir: string, symbols: string[]): { stateOf: StateFn; ready: number } {
  const book = new Map<string, { times: number[]; pct: (number | null)[] }>();
  for (const sym of symbols) {
    const raw = readJson<Funding[]>(join(gateDir, sym + '_funding.json'));
    if (!raw) continue;
    const arr = raw
      .map((x) => ({ t: Number(x.t), r: Number(x.r) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.r))
      .sort((a, b) => a.t - b.t);
    const times = arr.map((x) => x.t);
    const rates = arr.map((x) => x.r);
    const pct: (number | null)[] = [];
    for (let j = 0; j < arr.length; j += 1) {
      const lo = Math.max(0, j - 270 + 1);
      const n = j - lo + 1;
      if (n < 90) { pct.push(null); continue; }
      let cnt = 0;
      for (let k = lo; k <= j; k += 1) if (rates[k]! <= rates[j]!) cnt += 1;
      pct.push(cnt / n);
    }
    book.set(sym, { times, pct });
  }
  const stateOf: StateFn = (ctx) => {
    const f = book.get(ctx.sym);
    if (!f) return null;
    const t = ctx.bars[ctx.i]!.time;
    let lo = 0;
    let hi = f.times.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (f.times[mid]! <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0 || t - f.times[best]! > 3 * 86400) return null;
    const p = f.pct[best];
    if (p === null || p === undefined) return null;
    if (p >= 0.9) return 'F_high';
    if (p <= 0.1) return 'F_low';
    return 'F_mid';
  };
  return { stateOf, ready: book.size };
}

// ---------- 订单流 ----------

type BBar = { time: number; volume: number; takerBuy: number };

export function flowState(binanceDir: string, symbols: string[], intervals: string[], window = 50): { stateOf: StateFn; ready: number } {
  const book = new Map<string, Map<number, number>>();
  for (const iv of intervals) {
    for (const sym of symbols) {
      const raw = readJson<BBar[]>(join(binanceDir, sym + '_' + iv + '.json'));
      if (!raw) continue;
      const arr = raw
        .map((x) => ({ time: Number(x.time), volume: Number(x.volume), takerBuy: Number(x.takerBuy) }))
        .filter((x) => Number.isFinite(x.time) && x.volume > 0 && x.takerBuy > 0)
        .sort((a, b) => a.time - b.time);
      const ratio = arr.map((x) => x.takerBuy / x.volume);
      const map = new Map<number, number>();
      for (let j = window; j < arr.length; j += 1) {
        let cnt = 0;
        for (let k = j - window; k < j; k += 1) if (ratio[k]! <= ratio[j]!) cnt += 1;
        map.set(arr[j]!.time, cnt / window);
      }
      book.set(sym + '|' + iv, map);
    }
  }
  const stateOf: StateFn = (ctx) => {
    const map = book.get(ctx.sym + '|' + ctx.iv);
    if (!map) return null;
    const p = map.get(ctx.bars[ctx.i]!.time);
    if (p === undefined) return null;
    if (p >= 2 / 3) return 'T_high';
    if (p <= 1 / 3) return 'T_low';
    return 'T_mid';
  };
  return { stateOf, ready: book.size };
}

// ---------- 分组 ----------

export function levelGroup(h: Pick<Hit, 'state' | 'dir'>): string {
  if (h.state === 'S') return h.dir > 0 ? '支撑+看涨' : '支撑+看跌';
  if (h.state === 'R') return h.dir < 0 ? '阻力+看跌' : '阻力+看涨';
  if (h.state === 'B') return h.dir > 0 ? '跌破后看涨' : '跌破后看跌';
  if (h.state === 'A') return h.dir > 0 ? '突破后看涨' : '突破后看跌';
  if (h.state === 'M') return '中间';
  return '其他';
}

export function fundingGroup(h: Pick<Hit, 'state' | 'dir'>): string {
  if (h.state === 'F_high') return h.dir < 0 ? '高资金+做空' : '高资金+做多';
  if (h.state === 'F_low') return h.dir > 0 ? '低资金+做多' : '低资金+做空';
  return '资金中性';
}

export function flowGroup(h: Pick<Hit, 'state' | 'dir'>): string {
  if (h.state === 'T_high') return h.dir > 0 ? '流量确认' : '流量背离';
  if (h.state === 'T_low') return h.dir < 0 ? '流量确认' : '流量背离';
  return '流量中性';
}


// ---------- 持仓 / 清算 ----------

type StatRec = { t: number; oi: number; longLiq: number; shortLiq: number };

export type OiMode = 'liq' | 'oi';

/**
 * 清算失衡 / OI 变化分档。
 *
 * liq：最后一根 stats 的 (long_liq - short_liq) / (long_liq + short_liq)。
 *      多头被大量清算（imb 高）之后，看涨形态做多 = 清算反向；反过来 = 清算顺势。
 * oi：open_interest / 3 根前 - 1，落在过去 90 根的前 10% = OI放大，后 10% = OI收缩。
 *      两种都只当分层，不单独算方向假设之外的东西。
 */
export function oiState(
  gateDir: string, symbols: string[], intervals: string[], mode: OiMode = 'liq', lookback = 3,
): { stateOf: StateFn; ready: number } {
  type Book = { times: number[]; state: (string | null)[]; maxStale: number };
  const book = new Map<string, Book>();

  for (const iv of intervals) {
    const stale = iv === '1d' ? 5 * 86400 : 2 * 86400;
    for (const sym of symbols) {
      const raw = readJson<any[]>(join(gateDir, sym + '_stats_' + iv + '.json'));
      if (!raw) continue;
      const arr: StatRec[] = raw
        .map((x) => ({
          t: Number(x.t ?? x.time),
          oi: Number(x.open_interest),
          longLiq: Number(x.long_liq_size),
          shortLiq: Number(x.short_liq_size),
        }))
        .filter((x) => Number.isFinite(x.t) && x.t > 0)
        .sort((a, b) => a.t - b.t);
      if (arr.length < 30) continue;
      const times = arr.map((x) => x.t);
      const state: (string | null)[] = [];

      if (mode === 'liq') {
        for (const r of arr) {
          const total = r.longLiq + r.shortLiq;
          if (!(total > 0)) { state.push('L_mid'); continue; }
          const imb = (r.longLiq - r.shortLiq) / total;
          state.push(imb >= 0.5 ? 'L_long' : imb <= -0.5 ? 'L_short' : 'L_mid');
        }
      } else {
        const chg: number[] = arr.map(() => NaN);
        for (let j = lookback; j < arr.length; j += 1) {
          const prev = arr[j - lookback]!.oi;
          const cur = arr[j]!.oi;
          if (prev > 0 && cur > 0) chg[j] = cur / prev - 1;
        }
        for (let j = 0; j < arr.length; j += 1) {
          const c = chg[j];
          if (!Number.isFinite(c)) { state.push(null); continue; }
          const vals: number[] = [];
          for (let k = Math.max(0, j - 90 + 1); k <= j; k += 1) {
            const v = chg[k];
            if (Number.isFinite(v)) vals.push(v!);
          }
          if (vals.length < 30) { state.push(null); continue; }
          let cnt = 0;
          for (const v of vals) if (v <= c!) cnt += 1;
          const p = cnt / vals.length;
          state.push(p >= 0.9 ? 'OI_up' : p <= 0.1 ? 'OI_down' : 'OI_mid');
        }
      }
      book.set(sym + '|' + iv, { times, state, maxStale: stale });
    }
  }

  const stateOf: StateFn = (ctx) => {
    const b = book.get(ctx.sym + '|' + ctx.iv);
    if (!b) return null;
    const t = ctx.bars[ctx.i]!.time;
    let lo = 0;
    let hi = b.times.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (b.times[mid]! <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0 || t - b.times[best]! > b.maxStale) return null;
    return b.state[best] ?? null;
  };
  return { stateOf, ready: book.size };
}

export function liqGroup(h: Pick<Hit, 'state' | 'dir'>): string {
  if (h.state === 'L_long') return h.dir > 0 ? '清算反向' : '清算顺势';
  if (h.state === 'L_short') return h.dir < 0 ? '清算反向' : '清算顺势';
  return '清算中性';
}

export function oiGroup(h: Pick<Hit, 'state'>): string {
  if (h.state === 'OI_up') return 'OI放大';
  if (h.state === 'OI_down') return 'OI收缩';
  return 'OI中性';
}


// ---------- 逐笔大单 ----------

type AggRec = {
  t: number; buy: number; sell: number; largeBuy: number; largeSell: number;
  lateBuy: number; lateSell: number; trades: number; largeTrades: number;
};

export type AggMode = 'large' | 'late';

/**
 * 逐笔大单失衡。large：整根 4h 里 ≥ $50k 的成交；late：最后一小时的主动买卖。
 *
 * 阈值用「本币过去 90 根的 20/80 分位」，不用固定 0.3：BTC/ETH 的大单买卖
 * 常年接近平衡，固定阈值会让 98% 的根都落进中性（实测 1,016 条命中里只剩 14 条）。
 */
export function aggState(
  aggDir: string, symbols: string[], intervals: string[], mode: AggMode = 'large',
): { stateOf: StateFn; ready: number } {
  const book = new Map<string, Map<number, string>>();
  for (const iv of intervals) {
    for (const sym of symbols) {
      const raw = readJson<AggRec[]>(join(aggDir, sym + '_' + iv + '.json'));
      if (!raw) continue;
      const arr = raw.map((r) => ({ t: Number(r.t), buy: mode === 'large' ? r.largeBuy : r.lateBuy, sell: mode === 'large' ? r.largeSell : r.lateSell }))
        .filter((r) => Number.isFinite(r.t))
        .sort((a, b) => a.t - b.t);
      const imb = arr.map((r) => {
        const total = r.buy + r.sell;
        return total > 0 ? (r.buy - r.sell) / total : 0;
      });
      const map = new Map<number, string>();
      for (let j = 0; j < arr.length; j += 1) {
        if (j < 30) { map.set(arr[j]!.t, 'A_mid'); continue; }
        const vals: number[] = [];
        for (let k = Math.max(0, j - 90 + 1); k <= j; k += 1) vals.push(imb[k]!);
        let cnt = 0;
        for (const v of vals) if (v <= imb[j]!) cnt += 1;
        const p = cnt / vals.length;
        map.set(arr[j]!.t, p >= 0.8 ? 'A_buy' : p <= 0.2 ? 'A_sell' : 'A_mid');
      }
      book.set(sym + '|' + iv, map);
    }
  }
  const stateOf: StateFn = (ctx) => {
    const map = book.get(ctx.sym + '|' + ctx.iv);
    if (!map) return null;
    return map.get(ctx.bars[ctx.i]!.time) ?? null;
  };
  return { stateOf, ready: book.size };
}

export function aggGroup(h: Pick<Hit, 'state' | 'dir'>): string {
  if (h.state === 'A_buy') return h.dir > 0 ? '大单确认' : '大单背离';
  if (h.state === 'A_sell') return h.dir < 0 ? '大单确认' : '大单背离';
  return '大单中性';
}
