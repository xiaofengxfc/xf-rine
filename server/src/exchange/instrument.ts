/**
 * 把「裸合约名」补成「完整身份」。
 *
 * 交易所适配器只知道自己的符号（BTC_USDT），而页面需要知道这是哪一家的哪个市场。
 * 身份拼法统一走 @xfrine/instrument，这里只负责补上「当前是哪个交易所」。
 *
 * 双写期用：接口和行情帧同时带 contract 和 instrument。
 * 等前端全部改读 instrument，这一层和 contract 字段一起下掉。
 */
import { instrumentField, instrumentFromSymbol, type InstrumentRef } from '@xfrine/instrument';
import { exchange } from './index.js';

/** 当前交易所下这个符号的身份串 */
export function instrumentOf(symbol: string): string | undefined {
  return instrumentField(instrumentFromSymbol(symbol, exchange().id));
}

/** 同上，但给需要结构化身份的地方（以后缓存键、路由参数都用它） */
export function instrumentRefOf(symbol: string): InstrumentRef {
  return instrumentFromSymbol(symbol, exchange().id);
}
