/** Pure sizing checks for integer and fractional exchange contract lots. */
import { floorToSizeStep, isOnSizeStep, percentSizing } from '../src/lib/sizing.ts';

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function close(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 1e-10) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

close(floorToSizeStep(0.3, 0.1), 0.3, 'fractional boundary');
close(floorToSizeStep(2.56, 0.1), 2.5, 'round quantity down to lot step');
close(floorToSizeStep(0.333333333333, 0.01 / 0.03), 0.333333333333, 'repeating decimal step floor');
equal(isOnSizeStep(0.3, 0.1), true, 'decimal lot accepted');
equal(isOnSizeStep(0.35, 0.1), false, 'off-step lot rejected');
equal(isOnSizeStep(0.333333333333, 0.01 / 0.03), true, 'repeating decimal contract step accepted');

const fractional = percentSizing({
  available: 1000, pct: 25, price: 100, multiplier: 1,
  leverage: 10, feeRate: 0.001, sizeMin: 0.1, sizeStep: 0.1, sizeMax: 0,
});
close(fractional.size, 24.7, 'percentage size follows fractional step');

const underMinimum = percentSizing({
  available: 40, pct: 10, price: 100, multiplier: 1,
  leverage: 1, feeRate: 0, sizeMin: 0.1, sizeStep: 0.1, sizeMax: 0,
});
equal(underMinimum.size, 0, 'percentage budget below min is not increased');
equal(underMinimum.clamped, 'min', 'budget min warning');

const unaffordable = percentSizing({
  available: 5, pct: 100, price: 100, multiplier: 1,
  leverage: 1, feeRate: 0, sizeMin: 0.1, sizeStep: 0.1, sizeMax: 0,
});
equal(unaffordable.size, 0, 'unaffordable min stays zero');
equal(unaffordable.clamped, 'afford', 'unaffordable warning');

const capped = percentSizing({
  available: 10000, pct: 100, price: 100, multiplier: 1,
  leverage: 10, feeRate: 0, sizeMin: 0.1, sizeStep: 0.1, sizeMax: 6.35,
});
close(capped.size, 6.3, 'contract maximum is rounded down to step');
equal(capped.clamped, 'max', 'maximum warning');

console.log('Sizing checks passed: 13');
