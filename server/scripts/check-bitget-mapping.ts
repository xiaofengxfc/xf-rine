/** Offline checks for Bitget v2 order side and signed-size mapping. */
import { bitgetAccountSnapshot, bitgetOrderSide, signedBitgetOrderSize } from '../src/bitget/adapter.js';

const checks: [string, unknown, unknown][] = [
  ['hedge open long', bitgetOrderSide('hedge_mode', 'long', false), 'buy'],
  ['hedge close long keeps position side', bitgetOrderSide('hedge_mode', 'long', true), 'buy'],
  ['hedge open short', bitgetOrderSide('hedge_mode', 'short', false), 'sell'],
  ['hedge close short keeps position side', bitgetOrderSide('hedge_mode', 'short', true), 'sell'],
  ['one-way open long', bitgetOrderSide('one_way_mode', 'long', false), 'buy'],
  ['one-way close long', bitgetOrderSide('one_way_mode', 'long', true), 'sell'],
  ['one-way open short', bitgetOrderSide('one_way_mode', 'short', false), 'sell'],
  ['one-way close short', bitgetOrderSide('one_way_mode', 'short', true), 'buy'],
  ['buy order signed positive', signedBitgetOrderSize('buy', 0.01, 0.001), 10],
  ['sell order signed negative', signedBitgetOrderSize('sell', 0.01, 0.001), -10],
  ['map account equity and availability', JSON.stringify(bitgetAccountSnapshot({
    marginCoin: 'USDT', accountEquity: '125.5', available: '100', unrealizedPL: '2.5',
  })), JSON.stringify({ total: 125.5, available: 100, unrealised_pnl: 2.5, currency: 'USDT' })],
  ['map simulator equity field', bitgetAccountSnapshot({ marginCoin: 'USDT', equity: '88', available: '80', unrealizedPL: '-1' }).total, 88],
  ['map USDT equity and available margin in union mode', JSON.stringify(bitgetAccountSnapshot({ assetMode: 'union', accountEquity: '0', usdtEquity: '125.5', available: '0', unionAvailable: '100' })), JSON.stringify({ total: 125.5, available: 100, unrealised_pnl: 0, currency: 'USDT' })],
  ['map UTA account assets', JSON.stringify(bitgetAccountSnapshot({ accountEquity: '4994.725', usdtEquity: '5000', effEquity: '4994.72499999', usdtUnrealisedPnl: '0', assets: [{ coin: 'USDT', equity: '5000', balance: '5000', available: '5000', locked: '0' }] })), JSON.stringify({ total: 5000, available: 5000, unrealised_pnl: 0, currency: 'USDT' })],
  ['skip blank account values when falling back', JSON.stringify(bitgetAccountSnapshot({ accountEquity: '', usdtEquity: '88', available: '', unionAvailable: '80' })), JSON.stringify({ total: 88, available: 80, unrealised_pnl: 0, currency: 'USDT' })],
];
let failures = 0;
for (const [name, got, want] of checks) {
  if (got === want) console.log('  ✓ ' + name);
  else { failures += 1; console.error(`  ✗ ${name}: got ${got}, want ${want}`); }
}
if (failures) process.exit(1);
console.log('✓ Bitget v2 order mapping checks passed');
