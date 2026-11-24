/** 张 ↔ 币换算的纯检查。不碰 DOM，也不碰接口。 */
import {
  coinDecimalsOf, coinStepOf, coinsToContracts, coinsToInput, contractsToCoins, fmtCoins,
} from '../src/lib/units.ts';

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function close(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 1e-10) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

// BTC：1 张 = 0.0001 币，张步进 1 → 币步进 0.0001，四位小数
equal(coinStepOf(0.0001, 1), 0.0001, 'coin step follows multiplier');
equal(coinDecimalsOf(0.0001, 1), 4, 'coin decimals follow step');
equal(coinsToContracts(0.0123, 0.0001, 1), 123, 'whole coins to contracts');
equal(coinsToContracts(0.00005, 0.0001, 1), 0, 'below one lot stays zero');
equal(coinsToContracts(0.0003, 0.0001, 1), 3, 'float tail does not eat a lot');
close(contractsToCoins(12, 0.001), 0.012, 'contracts back to coins');
close(contractsToCoins(123, 0.0001), 0.0123, 'contracts back to btc coins');

// 币步进以外的位数一律向下取整，宁可少开一点
equal(coinsToContracts(0.0125, 0.001, 1), 12, 'extra digits round down');
equal(coinsToContracts(0.013, 0.001, 1), 13, 'exact digit kept');

// 小数张的合约：张步进 0.1，币步进跟着缩
equal(coinStepOf(1, 0.1), 0.1, 'fractional lot coin step');
equal(coinDecimalsOf(1, 0.1), 1, 'fractional lot coin decimals');
close(coinsToContracts(2.56, 1, 0.1), 2.5, 'fractional lot floors to step');

// 乘数不是 10 的幂也要准
equal(coinsToContracts(Number((3 * 0.5).toFixed(12)), 0.5, 1), 3, 'non power-of-ten multiplier');
equal(coinDecimalsOf(0.25, 1), 2, 'quarter coin decimals');

// 写进输入框的数字串：不带尾巴、不带科学计数法
equal(coinsToInput(3 * 0.1, 1), '0.3', 'input drops float tail');
equal(coinsToInput(0.012000000000000002, 4), '0.012', 'input drops long tail');
equal(coinsToInput(0.00000001, 8), '0.00000001', 'input keeps tiny amount');
equal(coinsToInput(0, 4), '', 'zero inputs as empty');
equal(coinsToInput(12, 0), '12', 'integer inputs plainly');

// 显示串：带千分位，但绝不把极小数抹成 0
equal(fmtCoins(12345.6789, 4), '12,345.6789', 'display groups thousands');
equal(fmtCoins(0.0001, 4), '0.0001', 'display keeps smallest lot');
equal(fmtCoins(0.000000000001, 12), '0.000000000001', 'display keeps 1e-12');

// 读不到乘数时不能编数
equal(coinStepOf(0, 1), 0, 'no multiplier no step');
equal(coinsToContracts(1, 0, 1), 0, 'no multiplier no contracts');
equal(contractsToCoins(5, 0), 0, 'no multiplier no coins');

console.log('Unit checks passed: 23');
