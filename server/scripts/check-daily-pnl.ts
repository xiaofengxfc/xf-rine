import { sumBitgetRealisedPnl, sumGateRealisedPnl } from '../src/exchange/pnl.js';

let failures = 0;
function check(name: string, got: number, expected: number): void {
  if (Math.abs(got - expected) < 1e-9) console.log('  ✓ ' + name);
  else {
    failures += 1;
    console.error(`  ✗ ${name}: got ${got}, expected ${expected}`);
  }
}

const fromMs = Date.UTC(2026, 10, 22, 0, 0, 0);
const toMs = Date.UTC(2026, 10, 23, 0, 0, 0);

check("Gate nets today's realized profits and losses, including partial reductions", sumGateRealisedPnl([
  { type: 'pnl', change: '12.5', time: fromMs / 1000 },
  { type: 'pnl', change: '-3.25', time: (fromMs + 1000) / 1000 },
  { type: 'pnl', change: '1.5', time: (fromMs + 2000) / 1000 },
], fromMs, toMs), 10.75);
check('Gate reports a negative net when today\'s closes are all losses', sumGateRealisedPnl([
  { type: 'pnl', change: '-2.5', time: fromMs / 1000 },
  { type: 'pnl', change: '-1.25', time: (fromMs + 1000) / 1000 },
], fromMs, toMs), -3.75);
check('Gate excludes fees, funding, and records outside the day', sumGateRealisedPnl([
  { type: 'pnl', change: '12', time: (fromMs - 1) / 1000 },
  { type: 'fee', change: '-1', time: (fromMs + 1000) / 1000 },
  { type: 'fund', change: '-2', time: (fromMs + 2000) / 1000 },
  { type: 'pnl', change: '4', time: toMs / 1000 },
], fromMs, toMs), 0);
check('Bitget nets close-fill profits and losses and excludes opening fills', sumBitgetRealisedPnl([
  { tradeSide: 'close', execPnl: '8.75', createdTime: fromMs },
  { tradeSide: 'close', execPnl: '-2.5', createdTime: fromMs + 1000 },
  { tradeSide: 'open', execPnl: '100', createdTime: fromMs + 2000 },
], fromMs, toMs), 6.25);
check('Bitget hedge-mode close_long and close_short fills are realized', sumBitgetRealisedPnl([
  { tradeSide: 'close_long', execPnl: '3.5', createdTime: fromMs },
  { tradeSide: 'close_short', execPnl: '-1.25', createdTime: fromMs + 1000 },
], fromMs, toMs), 2.25);
check('Bitget reports a negative net when today\'s closes are all losses', sumBitgetRealisedPnl([
  { tradeSide: 'close', execPnl: '-4', createdTime: fromMs },
], fromMs, toMs), -4);
check('Bitget excludes fills outside the client-local day', sumBitgetRealisedPnl([
  { tradeSide: 'close', execPnl: '10', createdTime: fromMs - 1 },
  { tradeSide: 'close', execPnl: '5', createdTime: toMs },
], fromMs, toMs), 0);

if (failures > 0) process.exit(1);
console.log('✓ Daily realized-PnL checks passed');
