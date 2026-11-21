import type { Position } from '../src/lib/api.ts';
import { sumUnrealisedPnl } from '../src/lib/position.ts';

function check(name: string, got: number, expected: number): void {
  if (Math.abs(got - expected) < 1e-9) console.log('  ✓ ' + name);
  else throw new Error(`${name}: got ${got}, expected ${expected}`);
}

const position = (unrealisedPnl: number) => ({ unrealisedPnl }) as Position;
check('open long and short floating PnL is netted across positions', sumUnrealisedPnl([
  position(125.5), position(-42.25), position(0),
]), 83.25);
check('empty position list has no floating PnL', sumUnrealisedPnl([]), 0);

console.log('✓ Open-position PnL checks passed');
