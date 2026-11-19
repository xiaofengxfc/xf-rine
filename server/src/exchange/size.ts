/** Number of decimal places needed to represent an exchange size increment. */
export function sizeStepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  const text = step.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return Math.min(12, text.includes('.') ? text.length - text.indexOf('.') - 1 : 0);
}

function ratioTolerance(ratio: number): number {
  return Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8;
}

export function floorSizeToStep(value: number, step: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  const unit = step > 0 && Number.isFinite(step) ? step : 1;
  const ratio = value / unit;
  const count = Math.floor(ratio + Math.max(1e-12, ratioTolerance(ratio)));
  return Number((count * unit).toFixed(12));
}

export function ceilSizeToStep(value: number, step: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  const unit = step > 0 && Number.isFinite(step) ? step : 1;
  const ratio = value / unit;
  const count = Math.ceil(ratio - ratioTolerance(ratio));
  return Number((count * unit).toFixed(12));
}

export function isSizeOnStep(value: number, step: number): boolean {
  if (!Number.isFinite(value)) return false;
  const unit = step > 0 && Number.isFinite(step) ? step : 1;
  const nearest = Math.round(value / unit) * unit;
  const tolerance = Math.max(1e-12, Number.EPSILON * Math.max(1, Math.abs(value)) * 8);
  return Math.abs(value - nearest) <= tolerance;
}
