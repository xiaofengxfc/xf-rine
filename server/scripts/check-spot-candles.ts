/**
 * 现货 K 线解析的自检。
 *
 * 最要紧的不是「能解析」，而是**顺序错了会被发现**：Gate 的现货 candlesticks
 * 是数组而不是对象，字段靠位置。位置猜错的话，图上会出现一张高低价颠倒、
 * 看着却像真的 K 线 —— 那比空白更糟。所以一半用例在钉 looksSane。
 */
import { looksSane, parseSpotCandles } from '../src/gate/spot.js';

let failures = 0;
function check(name: string, ok: boolean): void {
  if (ok) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}

// Gate 文档给的行格式：[t, 计价成交额, 收, 高, 低, 开, 基础成交量, 是否走完]
const good = [['1730000000', '1234.5', '101', '105', '99', '100', '12.3', 'true']];
const parsed = parseSpotCandles(good);
check('一行合法的现货 K 线能解析出来', parsed.length === 1);
check('四价对得上',
  parsed[0]?.o === '100' && parsed[0]?.h === '105' && parsed[0]?.l === '99' && parsed[0]?.c === '101');
check('时间用秒', parsed[0]?.t === 1730000000);
check('成交量用基础币', parsed[0]?.v === 12.3);
check('成交额用计价币', parsed[0]?.turnover === 1234.5);

// 字段顺序错了（高和低对调）：必须丢掉，而不是画一张颠倒的 K 线
const swapped = [['1730000000', '1234.5', '101', '99', '105', '100', '12.3', 'true']];
check('高低价对调的行被丢掉', parseSpotCandles(swapped).length === 0);

const badClose = [['1730000000', '1', '200', '105', '99', '100', '1', 'true']];
check('收盘价超出区间被丢掉', parseSpotCandles(badClose).length === 0);

check('不是数组的输入返回空', parseSpotCandles({ rows: [] }).length === 0 && parseSpotCandles(null).length === 0);
check('太短的行被跳过', parseSpotCandles([['1', '2', '3']]).length === 0);
check('价格是非数字的行被跳过', parseSpotCandles([['1730000000', '1', 'abc', '105', '99', '100', '1', 'true']]).length === 0);
check('价格为 0 的行被跳过', parseSpotCandles([['1730000000', '1', '0', '0', '0', '0', '0', 'true']]).length === 0);

const mixed = [good[0]!, swapped[0]!, good[0]!];
check('坏行不影响好行', parseSpotCandles(mixed).length === 2);

check('四价自洽', looksSane({ open: 100, high: 105, low: 99, close: 101 }));
check('最高价低于最低价说不通', !looksSane({ open: 100, high: 99, low: 105, close: 101 }));
check('开盘价高于最高价说不通', !looksSane({ open: 110, high: 105, low: 99, close: 101 }));
check('平盘（四价相同）说得通', looksSane({ open: 100, high: 100, low: 100, close: 100 }));

if (failures) process.exit(1);
console.log('✓ 现货 K 线解析检查通过');
