/**
 * Gate 现货的 K 线（只读，走 REST）。
 *
 * 为什么现货走 REST 而永续走 WebSocket：Gate 的现货 WS 频道（spot.candlesticks）
 * 帧里**不带货币对名**，要按订阅时的 payload 反查。那个映射我没法离线验证，
 * 而猜错的表现是「订阅成功、行情永远不来」—— 页面上只是看着像没数据，最难查。
 * REST 是数组格式、结构稳定，先用它把现货接上；WS 作为以后的增强。
 *
 * 解析里有一条自证：字段顺序如果和我以为的不一样，算出来的 h/l 自相矛盾
 * （最高价低于最低价之类）。这种时候整页丢掉，而不是把错的数据画到图上 ——
 * 一张看着正常、其实高低价颠倒的 K 线，比空白更糟。
 */
import { gatePublic } from './rest.js';
import type { XCandle } from '../exchange/types.js';

/**
 * Gate 现货 candlesticks 的一行：
 *   [时间(秒), 计价币成交额, 收盘, 最高, 最低, 开盘, 基础币成交量, 这根走完没有]
 *
 * 这个顺序是 Gate v4 文档给的。**顺序错了必须能被发现**，见 looksSane()。
 */
export function parseSpotCandles(raw: unknown): XCandle[] {
  if (!Array.isArray(raw)) return [];
  const out: XCandle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const t = Number(row[0]);
    const turnover = Number(row[1]);
    const close = Number(row[2]);
    const high = Number(row[3]);
    const low = Number(row[4]);
    const open = Number(row[5]);
    const volume = Number(row[6]);
    if (![t, close, high, low, open].every((n) => Number.isFinite(n) && n > 0)) continue;
    if (!looksSane({ open, high, low, close })) continue;
    out.push({
      t,
      o: String(open),
      h: String(high),
      l: String(low),
      c: String(close),
      v: Number.isFinite(volume) ? volume : 0,
      ...(Number.isFinite(turnover) ? { turnover } : {}),
    });
  }
  return out;
}

/**
 * 这一根的四价说得通吗。
 *
 * 最高价得是四价里最高的、最低价得是最低的。字段顺序一旦和文档对不上，
 * 这条几乎必然不成立 —— 于是当场丢掉，而不是把颠倒的 K 线画出去。
 */
export function looksSane(bar: { open: number; high: number; low: number; close: number }): boolean {
  const { open, high, low, close } = bar;
  if (high < low) return false;
  if (open > high || open < low) return false;
  if (close > high || close < low) return false;
  return true;
}

/** 现货 K 线一页。to 是「早于这个秒数」，和永续那边同一个语义 */
export async function spotCandles(
  symbol: string,
  interval: string,
  limit: number,
  to?: number,
): Promise<XCandle[]> {
  // Gate 现货的区间参数叫 from/to，且不含未来 —— 和永续的 to 语义相近
  const params: Record<string, string | number> = { currency_pair: symbol, interval, limit };
  if (to && to > 0) params.to = to;
  const raw = await gatePublic<unknown>('/spot/candlesticks', params);
  return parseSpotCandles(raw);
}
