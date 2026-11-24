/**
 * 把「裸合约名」补成「完整身份」。
 *
 * 交易所适配器只知道自己的符号（BTC_USDT），而页面需要知道这是哪一家的哪个市场。
 * 身份拼法统一走 @xfrine/instrument，这里只负责补上「当前是哪个交易所」。
 *
 * 双写期用：接口和行情帧同时带 contract 和 instrument。
 * 等前端全部改读 instrument，这一层和 contract 字段一起下掉。
 */
import { instrumentField, instrumentFromSymbol, parseInstrument, type InstrumentRef } from '@xfrine/instrument';
import { DataError } from '../errors.js';
import { exchange } from './index.js';

/** 当前交易所下这个符号的身份串 */
export function instrumentOf(symbol: string): string | undefined {
  return instrumentField(instrumentFromSymbol(symbol, exchange().id));
}

/** 同上，但给需要结构化身份的地方（以后缓存键、路由参数都用它） */
export function instrumentRefOf(symbol: string): InstrumentRef {
  return instrumentFromSymbol(symbol, exchange().id);
}

/**
 * 从请求参数里取品种符号：两套写法都认。
 *
 * 新参数 `instrument`（gate:perp:BTC_USDT）优先，老参数 `contract`（BTC_USDT）兜底。
 *
 * 给了 instrument 就必须和当前交易所对得上。理由很直接：这个服务端同一时刻只连一家，
 * 拿别家的身份来查行情，要的是「这台机器上根本没有的数据」——
 * 静默当成当前交易所，等于把两个市场的 K 线混成一条，图上还看不出来。
 */
export function resolveSymbol(input: {
  instrument?: unknown;
  contract?: unknown;
  fallback: string;
  what?: string;
}): string {
  const raw = typeof input.instrument === 'string' ? input.instrument.trim() : '';
  if (raw) {
    const ref = parseInstrument(raw);
    if (!ref) {
      throw new DataError(400, 'BAD_INSTRUMENT',
        '品种写法不对：' + raw + '。要写成 venue:market:symbol，例如 gate:perp:BTC_USDT');
    }
    const active = exchange().id;
    if (ref.venue !== active) {
      throw new DataError(400, 'OTHER_VENUE',
        '这个品种属于 ' + ref.venue + '，当前服务端连的是 ' + active + '。切换交易所之后再查');
    }
    return ref.symbol;
  }
  const legacy = typeof input.contract === 'string' ? input.contract.trim() : '';
  return legacy || input.fallback;
}
