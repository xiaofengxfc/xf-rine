/**
 * 品种身份在前端这一侧的入口。
 *
 * 解析和拼串的逻辑都在 @xfrine/instrument 里，前后端同一份 —— 前端不能自己拼
 * `gate:perp:BTC_USDT`，否则两边的格式迟早会分叉，而这个串是要进存档和地址栏的。
 */
import { parseInstrument } from '@xfrine/instrument';

export {
  instrumentField, instrumentFromSymbol, instrumentKey, parseInstrument, parseInstrumentOr, sameInstrument,
  MARKETS, VENUES,
  type InstrumentRef, type MarketKind, type VenueId,
} from '@xfrine/instrument';

/**
 * 行情缓存 / 图表重建用的键。
 *
 * 两端必须算得一模一样：App 用它判断「手上这份行情是不是当前品种的」，
 * useMarketFeed 用它当缓存 Map 的键。各拼各的迟早会差一个字符，
 * 症状是切品种之后数据不刷新 —— 而那种 bug 很难看出来。
 *
 * 有身份就用身份（换交易所时同名合约是两个品种），没有就退回老的
 * `符号:周期`，和老行为完全一致。
 */
export function marketKeyOf(symbol: string, interval: string, instrument?: string): string {
  return (instrument || symbol) + ':' + interval;
}

/**
 * 从存档里取回品种符号。
 *
 * 老存档里只有裸符号（`BTC_USDT`），新存档里是完整身份。认不出完整身份就返回 null，
 * 由调用方退回默认值 —— 一个坏掉的字段不该让页面打不开。
 */
export function storedSymbol(raw: unknown): string | null {
  const ref = parseInstrument(raw);
  return ref ? ref.symbol : null;
}
