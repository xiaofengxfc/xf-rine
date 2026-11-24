/**
 * 交易品种的身份。
 *
 * 这个项目里所有东西都以「某个市场里的某个品种」为单位：K 线、持仓、委托、
 * 画线、缓存键、本地存储、地址栏参数。以前这个身份就是一个裸字符串
 * （Gate 的 `BTC_USDT`），于是它同时承担了三件事：
 *   1. 品种名；
 *   2. 隐含的交易所（看当前配置猜）；
 *   3. 隐含的市场类型（默认为 USDT 永续）。
 *
 * 一旦要加第二家交易所、现货、交割、期权或者股票，第 2、3 条就不再成立 ——
 * 同一个 `BTC_USDT` 在不同交易所、不同市场里是**不同的东西**，
 * 拿它当主键会把两家的持仓和 K 线混成一份。
 *
 * 所以身份改成三段：`venue:market:symbol`，例如 `gate:perp:BTC_USDT`。
 * 这个串会进 localStorage 和地址栏，**改动要写迁移**，所以格式只在下面这几个
 * 函数里生成和解析，别的地方不许自己拼。
 *
 * 只列当前真的存在的东西：market 现在只有 perp。现货、交割、期权等到真接进来时
 * 再加 —— 提前预留一个永远走不到的枚举值，只会让 switch 看起来更完整而更不可靠。
 */

/** 哪一家。这里的值要和 server/src/exchange 里的 ExchangeId 对得上 */
export type VenueId = 'gate' | 'bitget';

/** 哪一类市场。现在只有 USDT 永续（含交割？没有。加的时候再说） */
export type MarketKind = 'perp';

export interface InstrumentRef {
  venue: VenueId;
  market: MarketKind;
  /** 交易所自己的符号，例如 BTC_USDT */
  symbol: string;
}

export const VENUES: readonly VenueId[] = ['gate', 'bitget'];
export const MARKETS: readonly MarketKind[] = ['perp'];

/** 从字符串里认出来的 venue / market 用这套正则卡住：拼错了要认不出，不能悄悄当成 gate */
const VENUE_RE = /^[a-z0-9]{2,16}$/;
const MARKET_RE = /^[a-z]{2,16}$/;
/** 符号：字母数字和下划线。Gate 是 BTC_USDT，Bitget 也是；别家可能带连字符，到时候再放宽 */
const SYMBOL_RE = /^[A-Za-z0-9_]{2,40}$/;

function isVenue(value: string): value is VenueId {
  return (VENUES as readonly string[]).includes(value);
}

function isMarket(value: string): value is MarketKind {
  return (MARKETS as readonly string[]).includes(value);
}

/**
 * 身份 → 规范串。不校验，只拼：调用方拿到的是自己构造的 ref，
 * 真要把外面的字符串当输入，用 parseInstrument 那一侧。
 */
export function instrumentKey(ref: InstrumentRef): string {
  return ref.venue + ':' + ref.market + ':' + ref.symbol;
}

/**
 * 规范串 → 身份。认不出就返回 null，**不抛异常**：
 * 它会被用在「读上一次保存的品种」这种地方，存档坏了应该退回默认，
 * 而不是让整个页面打不开。
 */
export function parseInstrument(raw: unknown): InstrumentRef | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [venue, market, symbol] = parts as [string, string, string];
  if (!VENUE_RE.test(venue) || !isVenue(venue)) return null;
  if (!MARKET_RE.test(market) || !isMarket(market)) return null;
  if (!SYMBOL_RE.test(symbol)) return null;
  return { venue, market, symbol };
}

/** 认不出就给一个默认值，省得每处都写一遍 ?? */
export function parseInstrumentOr(raw: unknown, fallback: InstrumentRef): InstrumentRef {
  return parseInstrument(raw) ?? fallback;
}

/**
 * 老的裸符号（`BTC_USDT`）当输入时怎么办。
 *
 * 过渡期一定会遇到：localStorage 里存的、旧链接里的、外部脚本传的都可能是裸符号。
 * 这里按「当前交易所 + 永续」补全 —— 那正是这些老数据的隐含语义。
 */
export function instrumentFromSymbol(symbol: string, venue: VenueId, market: MarketKind = 'perp'): InstrumentRef {
  return { venue, market, symbol };
}

/** 两个身份是不是同一个品种 */
export function sameInstrument(a: InstrumentRef | null | undefined, b: InstrumentRef | null | undefined): boolean {
  if (!a || !b) return false;
  return a.venue === b.venue && a.market === b.market && a.symbol === b.symbol;
}

/**
 * 给对外的接口用：能拼成规范串就拼，拼不了就返回 undefined。
 * 接口里这个字段是可选的，老客户端不认它也不该因此报错。
 */
export function instrumentField(ref: InstrumentRef | null | undefined): string | undefined {
  return ref ? instrumentKey(ref) : undefined;
}
