/**
 * 品种身份的自检。
 *
 * 这个串会进 localStorage 和地址栏，是最容易被外部输入喂到的地方
 * （旧存档、旧链接、外部脚本）。所以「认不出时必须返回 null，而不是瞎猜」
 * 比「能认出来」更要紧 —— 下面一半用例是在钉这一条。
 */
import {
  capabilitiesFor, instrumentField, instrumentFromSymbol, instrumentKey, parseInstrument, parseInstrumentOr,
  PERP_CAPABILITIES, sameInstrument, WIRED_MARKETS,
} from '@xfrine/instrument';

let failures = 0;
function check(name: string, ok: boolean): void {
  if (ok) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}

const btc = { venue: 'gate', market: 'perp', symbol: 'BTC_USDT' } as const;

check('拼出来的就是规范串', instrumentKey(btc) === 'gate:perp:BTC_USDT');
check('解析回去和原来一致', sameInstrument(parseInstrument('gate:perp:BTC_USDT'), btc));
check('另一家交易所也认', sameInstrument(parseInstrument('bitget:perp:ETH_USDT'), { venue: 'bitget', market: 'perp', symbol: 'ETH_USDT' }));
check('带数字的符号照样认', sameInstrument(parseInstrument('gate:perp:1000PEPE_USDT'), { venue: 'gate', market: 'perp', symbol: '1000PEPE_USDT' }));

// ---- 认不出的必须返回 null，不能猜 ----
check('少了 market 段不认', parseInstrument('gate:BTC_USDT') === null);
check('多了一段不认', parseInstrument('gate:perp:BTC_USDT:extra') === null);
check('不认识的交易所说 null', parseInstrument('binance:perp:BTC_USDT') === null);
check('还没进身份体系的市场类型说 null', parseInstrument('gate:option:BTC_USDT') === null);
check('空的符号说 null', parseInstrument('gate:perp:') === null);
check('符号里有空格说 null', parseInstrument('gate:perp:BTC USDT') === null);
check('非字符串说 null', parseInstrument(42) === null && parseInstrument(null) === null && parseInstrument(undefined) === null);
check('随便一段文本说 null', parseInstrument('BTC_USDT') === null);

// ---- 兜底 ----
const fallback = instrumentFromSymbol('ETH_USDT', 'gate');
check('认不出时按默认值兜底', sameInstrument(parseInstrumentOr('坏掉的存档', fallback), fallback));
check('认得出时用认出来的', sameInstrument(parseInstrumentOr('bitget:perp:SOL_USDT', fallback), { venue: 'bitget', market: 'perp', symbol: 'SOL_USDT' }));

// ---- 给接口用的字段 ----
check('身份转成接口字段', instrumentField(btc) === 'gate:perp:BTC_USDT');
check('没有身份就不带字段', instrumentField(null) === undefined && instrumentField(undefined) === undefined);

// ---- 等价判断 ----
check('同一品种判等', sameInstrument(btc, { ...btc }));
check('不同交易所不算同一个', !sameInstrument(btc, { ...btc, venue: 'bitget' }));
check('空值不算相等', !sameInstrument(null, btc) && !sameInstrument(btc, null));

// ---- 市场能力表 ----
const perp = capabilitiesFor('perp');
check('永续有这张能力表', perp !== null);
check('永续能开空、有杠杆、有资金费',
  perp?.canShort === true && perp?.hasLeverage === true && perp?.hasFunding === true);
check('永续不过期、24 小时不停', perp?.hasExpiry === false && perp?.hasSession === false);
check('永续有持仓、有强平、能挂触发单',
  perp?.hasPositions === true && perp?.hasLiquidation === true && perp?.hasTriggerOrders === true);
check('永续按张下单', perp?.sizeUnit === 'contract');
check('认不出的市场返回 null（不是一张「什么都不能」的空表）', capabilitiesFor('futures') === null);

// ---- 现货：进了身份体系，但还没接数据源 ----
const spot = capabilitiesFor('spot');
check('现货有准确的能力表', spot !== null && spot.canShort === false && spot.hasLeverage === false);
check('现货没有持仓、没有强平、没有资金费',
  spot?.hasPositions === false && spot?.hasLiquidation === false && spot?.hasFunding === false);
check('现货按基础币下单', spot?.sizeUnit === 'base');
check('现货能进身份串', instrumentKey({ venue: 'gate', market: 'spot', symbol: 'BTC_USDT' }) === 'gate:spot:BTC_USDT');
check('现货身份能解析回来', sameInstrument(parseInstrument('gate:spot:BTC_USDT'), { venue: 'gate', market: 'spot', symbol: 'BTC_USDT' }));
check('但现货不在「已接数据源」名单里', !WIRED_MARKETS.includes('spot') && WIRED_MARKETS.includes('perp'));
check('能力表是只读常量，改不动别人', PERP_CAPABILITIES.label === '永续合约');

// ---- 行情缓存键与身份串是两件事 ----
// marketKeyOf 在前端，但规则在这里一并钉住：它有身份就用身份，没有就退回裸符号。
const marketKeyOf = (symbol: string, interval: string, instrument?: string): string =>
  (instrument || symbol) + ':' + interval;

check('没有身份时键就是老的写法', marketKeyOf('BTC_USDT', '15m') === 'BTC_USDT:15m');
check('有身份时键里带身份', marketKeyOf('BTC_USDT', '15m', 'gate:perp:BTC_USDT') === 'gate:perp:BTC_USDT:15m');
check('同一品种在两家交易所不是同一个键',
  marketKeyOf('BTC_USDT', '15m', 'gate:perp:BTC_USDT') !== marketKeyOf('BTC_USDT', '15m', 'bitget:perp:BTC_USDT'));
check('换周期换键', marketKeyOf('BTC_USDT', '15m', 'gate:perp:BTC_USDT') !== marketKeyOf('BTC_USDT', '1h', 'gate:perp:BTC_USDT'));

if (failures) process.exit(1);
console.log('✓ 品种身份检查通过');
