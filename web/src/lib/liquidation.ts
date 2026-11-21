import type { Account, Position } from './api.ts';

/**
 * Liquidation prices are an estimate when the exchange does not return one.
 * The exact cross-margin price also depends on maintenance tiers, fees and
 * the rest of the account, so callers should render this value as approximate.
 */
export interface LiquidationInput {
  side: 'long' | 'short';
  entryPrice: number;
  size: number;
  multiplier: number;
  leverage: number;
  marginMode?: 'isolated' | 'cross';
  /** Collateral available to absorb an adverse move, in USDT. */
  collateral?: number;
  /** Keep a small maintenance-margin buffer in the cross estimate. */
  maintenanceRate?: number;
}

const finitePositive = (value: number | undefined): number =>
  Number.isFinite(value) && (value ?? 0) > 0 ? value as number : 0;

/**
 * Estimate the price at which a position would lose its available collateral.
 *
 * Isolated mode keeps the existing ticket behaviour (one leverage fraction).
 * Cross mode uses account collateral and the contracts represented by one
 * position. The maintenance buffer is deliberately small and configurable.
 */
export function estimateLiquidationPrice(input: LiquidationInput): number {
  const entry = finitePositive(input.entryPrice);
  const size = finitePositive(input.size);
  const multiplier = finitePositive(input.multiplier);
  if (!(entry > 0) || !(size > 0) || !(multiplier > 0)) return 0;

  const side = input.side === 'short' ? 'short' : 'long';
  const cross = input.marginMode === 'cross';
  if (!cross) {
    const leverage = finitePositive(input.leverage);
    if (!(leverage > 0)) return 0;
    const move = 1 / leverage;
    return side === 'long' ? entry * (1 - move) : entry * (1 + move);
  }

  const collateral = finitePositive(input.collateral);
  const contracts = size * multiplier;
  if (!(collateral > 0) || !(contracts > 0)) return 0;
  const maintenance = Math.min(0.2, Math.max(0, input.maintenanceRate ?? 0.005));
  const collateralPerCoin = collateral / contracts;
  const price = side === 'long'
    ? (entry - collateralPerCoin) / (1 - maintenance)
    : (entry + collateralPerCoin) / (1 + maintenance);
  // A long position can be fully covered by cross collateral. There is no
  // positive liquidation price in that case, so let the UI explain the dash.
  return price > 0 && Number.isFinite(price) ? price : 0;
}

/** A long has no positive liquidation level when its collateral covers a fall to zero. */
export function crossCollateralCoversDropToZero(input: LiquidationInput): boolean {
  const entry = finitePositive(input.entryPrice);
  const size = finitePositive(input.size);
  const multiplier = finitePositive(input.multiplier);
  const collateral = finitePositive(input.collateral);
  if (!(entry > 0) || !(size > 0) || !(multiplier > 0) || !(collateral > 0)) return false;
  if (input.side !== 'long' || input.marginMode !== 'cross') return false;
  return collateral >= entry * size * multiplier;
}

/** Gate reports cross positions with leverage=0 and frequently omits liqPrice. */
export function isCrossPosition(position: Pick<Position, 'leverage' | 'marginMode'>): boolean {
  if (position.marginMode === 'cross') return true;
  if (position.marginMode === 'isolated') return false;
  return !(finitePositive(position.leverage) > 0);
}

/**
 * Prefer the exchange's value. Fall back to a cross estimate for a position
 * whose response has no liquidation price. The current mark is the base for
 * existing cross positions because account.total already includes current PnL.
 */
export function positionLiquidationPrice(
  position: Position,
  account: Account | null | undefined,
  markPrice = position.markPrice,
): number {
  if (finitePositive(position.liqPrice) > 0) return position.liqPrice;
  const multiplier = finitePositive(position.multiplier)
    || (position.size > 0 && position.markPrice > 0 && position.value > 0
      ? position.value / (Math.abs(position.size) * position.markPrice)
      : 0);
  if (!(multiplier > 0)) return 0;
  const side = position.direction === 'short' ? 'short' : 'long';
  if (isCrossPosition(position)) {
    const collateral = finitePositive(account?.total) || finitePositive(account?.available);
    return estimateLiquidationPrice({
      side,
      entryPrice: finitePositive(markPrice) || finitePositive(position.markPrice) || position.entryPrice,
      size: Math.abs(position.size),
      multiplier,
      leverage: 0,
      marginMode: 'cross',
      collateral,
    });
  }
  return estimateLiquidationPrice({
    side,
    entryPrice: position.entryPrice,
    size: Math.abs(position.size),
    multiplier,
    leverage: position.leverage,
    marginMode: 'isolated',
  });
}
