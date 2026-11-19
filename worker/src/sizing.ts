/** Shared validation for quantities expressed in exchange contracts. */
export function floorSizeToStep(value: number, step: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  const unit = step > 0 && Number.isFinite(step) ? step : 1;
  const ratio = value / unit;
  const count = Math.floor(ratio + Math.max(1e-12, Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8));
  return Number((count * unit).toFixed(12));
}

export function ceilSizeToStep(value: number, step: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  const unit = step > 0 && Number.isFinite(step) ? step : 1;
  const ratio = value / unit;
  const count = Math.ceil(ratio - Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8);
  return Number((count * unit).toFixed(12));
}

export function isSizeOnStep(value: number, step: number): boolean {
  if (!Number.isFinite(value)) return false;
  const unit = step > 0 && Number.isFinite(step) ? step : 1;
  const nearest = Math.round(value / unit) * unit;
  const tolerance = Math.max(1e-12, Number.EPSILON * Math.max(1, Math.abs(value)) * 8);
  return Math.abs(value - nearest) <= tolerance;
}
