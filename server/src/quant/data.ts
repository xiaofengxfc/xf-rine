
/**
 * 回测用的历史 K 线。
 *
 * Gate 的公共行情接口一次只给 1000 根，但可以拿 `to` 往前翻：实测 15m 能翻到 60 天，
 * 1h 能翻到 166 天。翻页是回测能不能做的前提 —— 只拉最新一页的话，15m 只有 10 天，
 * 连二十笔交易都凑不出来，什么结论都是噪音。
 *
 * 这里做三件事：
 *   1. 往前翻页，直到攒够要的根数、或者交易所不给更早的了。
 *   2. 落到磁盘缓存（按 合约:周期），重跑同一次回测不再打交易所。
 *   3. 清洗：去掉未收盘的最后一根、去重、按时间升序，并报告中间断档了多少。
 *
 * 断档必须报出来。交易所对没有成交的时段会补占位 K 线，但历史太老的那一段是真的没有；
 * 拿一段中间缺了三个月的 K 线算出来的胜率，比不比都别信。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_DIR } from '../config.js';
import { gatePublic } from '../gate/rest.js';
import type { Candle } from './backtest.js';

/** 缓存放在用户目录：换设备、重装都不会把几十兆的 K 线删掉 */
export const KLINE_CACHE_DIR = join(HOME_DIR, 'quant-kline');
/** 缓存多久之后允许再往前补。历史不会变，但最新那一截会长 */
const STALE_MS = 6 * 3600_000;

export interface Series {
  contract: string;
  interval: string;
  candles: Candle[];
  /** 这本地的缓存是从哪来的 */
  source: 'cache' | 'cache+fetch' | 'fetch';
  fetchedAt: number;
  /** 中间缺了多少根（按周期推出来的），0 表示连续 */
  gaps: number;
  /** 最老一根和最新一根的时间（unix 秒） */
  span: { from: number; to: number };
}

/** Gate 的 K 线周期写法 */
export const GATE_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d'] as const;
export type GateInterval = typeof GATE_INTERVALS[number];

export function intervalSeconds(iv: string): number {
  const m = /^(\d+)([mhd])$/.exec(iv);
  if (!m) return 60;
  const n = Number(m[1]);
  return m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n * 86400;
}

interface GateCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: number;
  sum?: string;
}

function cachePath(contract: string, interval: string): string {
  // 合约名和周期都会进文件名，过滤掉能跳出目录的字符
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(KLINE_CACHE_DIR, safe(contract) + '__' + safe(interval) + '.json');
}

function readCache(contract: string, interval: string): Series | null {
  const p = cachePath(contract, interval);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Series;
    if (!Array.isArray(raw.candles) || raw.candles.length === 0) return null;
    return raw;
  } catch {
    // 读坏了当没有：宁可重拉，也不要拿半份 K 线去回测
    return null;
  }
}

function writeCache(s: Series): void {
  try {
    mkdirSync(KLINE_CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(s.contract, s.interval), JSON.stringify(s), { encoding: 'utf8' });
  } catch {
    // 写不进去不影响这一次回测，只是下次要重拉
  }
}

/**
 * 拉一页。`to` 是"只回早于这个时间的"，闭区间，所以往前翻页要减一根 ——
 * 不减的话每次都会把上一页最老那根再带回来一次，翻十页多十根重复。
 */
async function fetchPage(contract: string, interval: string, to: number | null): Promise<Candle[]> {
  const query: Record<string, string | number> = { contract, interval, limit: 1000 };
  if (to !== null) query.to = to;
  const list = await gatePublic<GateCandle[]>('/futures/usdt/candlesticks', query, 5 * 60_000, 20_000);
  if (!Array.isArray(list)) return [];
  return list.map((c) => ({
    t: Number(c.t),
    o: Number(c.o),
    h: Number(c.h),
    l: Number(c.l),
    c: Number(c.c),
    v: Number(c.v),
  }));
}

/**
 * 往前翻页直到攒够 `wanted` 根，或者交易所不给更早的了。
 *
 * `maxPages` 是硬上限：翻一百页是十万根，内存和等待都不值得，
 * 而且要的根数一般用不了那么多。到上限就返回手上这些，由调用方决定够不够。
 */
async function fetchBack(
  contract: string,
  interval: string,
  wanted: number,
  maxPages = 20,
  existing: Candle[] = [],
): Promise<Candle[]> {
  const byTime = new Map<number, Candle>();
  for (const c of existing) byTime.set(c.t, c);

  let to: number | null = null;
  if (existing.length > 0) {
    const oldest = Math.min(...existing.map((c) => c.t));
    to = oldest - intervalSeconds(interval);
  }

  for (let page = 0; page < maxPages; page++) {
    if (byTime.size >= wanted) break;
    let rows: Candle[];
    try {
      rows = await fetchPage(contract, interval, to);
    } catch {
      // 交易所报错时别把已有的丢掉：能回测多少算多少，调用方会按根数判断够不够
      break;
    }
    if (rows.length === 0) break;
    for (const c of rows) if (!byTime.has(c.t)) byTime.set(c.t, c);
    const oldest = Math.min(...rows.map((c) => c.t));
    if (to !== null && oldest >= to) break; // 交易所没再往前给，别死循环
    to = oldest - intervalSeconds(interval);
    if (rows.length < 1000) break; // 不满一页，到头了
  }

  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** 去掉未收盘的一根、去重、按时间升序，并数出中间断了几根 */
function clean(rows: Candle[], interval: string): { candles: Candle[]; gaps: number } {
  const step = intervalSeconds(interval);
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const c of rows) {
    if (!Number.isFinite(c.t) || !(c.o > 0) || !(c.c > 0)) continue;
    if (seen.has(c.t)) continue;
    seen.add(c.t);
    out.push(c);
  }
  out.sort((a, b) => a.t - b.t);

  // 最后一根如果还没走完就不算：它的最高最低还会变，拿来当已收盘数据是作弊
  const lastT = out.length ? out[out.length - 1]!.t : 0;
  if (out.length && lastT + step > Date.now() / 1000) out.pop();

  let gaps = 0;
  for (let i = 1; i < out.length; i++) {
    const diff = out[i]!.t - out[i - 1]!.t;
    if (diff > step) gaps += Math.round(diff / step) - 1;
  }
  return { candles: out, gaps };
}

/**
 * 拿一段历史 K 线。
 *
 * `wanted` 是要多少根。缓存够就全用缓存；不够就往前补。
 * 两个阈值：
 *   · 缓存还很新（6 小时内拉过）并且根数够 —— 直接用
 *   · 否则从缓存最老那根继续往前翻，翻完并回缓存
 */
export async function getSeries(
  contract: string,
  interval: string,
  wanted: number,
): Promise<Series> {
  const cached = readCache(contract, interval);
  const fresh = cached && Date.now() - cached.fetchedAt < STALE_MS;
  if (cached && fresh && cached.candles.length >= wanted) {
    const { candles, gaps } = clean(cached.candles, interval);
    return {
      ...cached,
      candles,
      gaps,
      source: 'cache',
      span: { from: candles[0]?.t ?? 0, to: candles[candles.length - 1]?.t ?? 0 },
    };
  }

  const rows = await fetchBack(contract, interval, wanted, 20, cached?.candles ?? []);
  const { candles, gaps } = clean(rows, interval);
  const series: Series = {
    contract,
    interval,
    candles,
    source: cached ? 'cache+fetch' : 'fetch',
    fetchedAt: Date.now(),
    gaps,
    span: { from: candles[0]?.t ?? 0, to: candles[candles.length - 1]?.t ?? 0 },
  };
  if (candles.length > 0) writeCache(series);
  return series;
}
