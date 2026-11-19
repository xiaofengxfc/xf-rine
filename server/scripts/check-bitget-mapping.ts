/** Offline checks for Bitget v2 order side and signed-size mapping. */
import { bitgetOrderSide, signedBitgetOrderSize } from '../src/bitget/adapter.js';

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
];
let failures = 0;
for (const [name, got, want] of checks) {
  if (got === want) console.log('  ✓ ' + name);
  else { failures += 1; console.error(`  ✗ ${name}: got ${got}, want ${want}`); }
}
if (failures) process.exit(1);
console.log('✓ Bitget v2 order mapping checks passed');
