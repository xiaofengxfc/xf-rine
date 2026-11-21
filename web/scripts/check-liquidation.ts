import type { Account, Position } from '../src/lib/api.ts';
import {
  crossCollateralCoversDropToZero, estimateLiquidationPrice, positionLiquidationPrice,
} from '../src/lib/liquidation.ts';

function close(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 1e-8) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function equal(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

close(estimateLiquidationPrice({
  side: 'long', entryPrice: 100, size: 1, multiplier: 1,
  leverage: 10, marginMode: 'isolated',
}), 90, 'isolated long retains leverage estimate');
close(estimateLiquidationPrice({
  side: 'short', entryPrice: 100, size: 1, multiplier: 1,
  leverage: 10, marginMode: 'isolated',
}), 110, 'isolated short retains leverage estimate');

const crossLong = estimateLiquidationPrice({
  side: 'long', entryPrice: 10_000, size: 1, multiplier: 1,
  leverage: 10, marginMode: 'cross', collateral: 1_000,
});
close(crossLong, (10_000 - 1_000) / 0.995, 'cross long solves equity against maintenance margin');

const crossShort = estimateLiquidationPrice({
  side: 'short', entryPrice: 10_000, size: 1, multiplier: 1,
  leverage: 10, marginMode: 'cross', collateral: 1_000,
});
close(crossShort, (10_000 + 1_000) / 1.005, 'cross short solves equity against maintenance margin');

const position: Position = {
  contract: 'BTC_USDT', size: 1, direction: 'long', leverage: 10,
  entryPrice: 10_000, markPrice: 9_900, liqPrice: 0, unrealisedPnl: -100,
  value: 9_900, mode: 'single', marginMode: 'cross', multiplier: 1,
};
const account: Account = { total: 1_000, available: 900, unrealisedPnl: -100, currency: 'USDT' };
close(positionLiquidationPrice(position, account), (9_900 - 1_000) / 0.995,
  'position fallback uses the live mark and account collateral');
close(positionLiquidationPrice(position, account, 0), (9_900 - 1_000) / 0.995,
  'stale mark fallback keeps the position snapshot mark');

equal(positionLiquidationPrice({ ...position, liqPrice: 8_500 }, account), 8_500,
  'exchange liquidation price takes precedence');
equal(positionLiquidationPrice({ ...position, multiplier: 0, value: 0 }, account), 0,
  'estimate is omitted when contract multiplier is unavailable');
equal(positionLiquidationPrice(position, null), 0,
  'cross estimate is omitted when account collateral is unavailable');
equal(positionLiquidationPrice({ ...position, marginMode: 'isolated', leverage: 0 }, account), 0,
  'explicit isolated mode is not inferred as cross when leverage is unavailable');
equal(estimateLiquidationPrice({
  side: 'long', entryPrice: 100, size: 1, multiplier: 1,
  leverage: 1, marginMode: 'cross', collateral: 200,
}), 0, 'no positive liquidation price is returned when collateral covers the full move');
close(estimateLiquidationPrice({
  side: 'long', entryPrice: 100, size: 1, multiplier: 1,
  leverage: 1, marginMode: 'cross', collateral: 99.75,
}), (100 - 99.75) / 0.995, 'cross long remains liquidatable just below full notional collateral');
equal(Number(crossCollateralCoversDropToZero({
  side: 'long', entryPrice: 100, size: 1, multiplier: 1,
  leverage: 1, marginMode: 'cross', collateral: 100,
})), 1, 'ticket can explain when collateral covers a fall to zero');
equal(Number(crossCollateralCoversDropToZero({
  side: 'long', entryPrice: 100, size: 1, multiplier: 1,
  leverage: 1, marginMode: 'cross', collateral: 99.75,
})), 0, 'ticket does not claim zero-price coverage below full notional collateral');
equal(Number(crossCollateralCoversDropToZero({
  side: 'long', entryPrice: 100, size: 1, multiplier: 1,
  leverage: 1, marginMode: 'cross', collateral: 99,
})), 0, 'ticket does not claim zero-price coverage without enough collateral');

console.log('Liquidation checks passed: 15');
