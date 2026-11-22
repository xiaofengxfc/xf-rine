/** Shared appearance for current and historical support/resistance levels. */
export interface ChartZoneLineStyle {
  color: string;
  width: 2;
  title: string;
  axisLabelVisible: boolean;
}

const ZONE_OPACITY = '0.92';

export function chartZoneLineStyle(input: {
  type: 'support' | 'resistance';
  history: boolean;
  priceLabel: string;
  pTouch: number | null;
  pHold: number | null;
  compactLabel?: boolean;
}): ChartZoneLineStyle {
  const historical = input.history;
  const color = input.type === 'support'
    ? `rgba(46,211,160,${ZONE_OPACITY})`
    : `rgba(255,95,109,${ZONE_OPACITY})`;
  const pct = (v: number | null) => v === null ? '—' : `${Math.round(v * 100)}%`;
  const label = input.type === 'support' ? '支撑' : '阻力';
  return {
    color,
    width: 2,
    title: historical
      ? ''
      : input.compactLabel
        ? label
        : `${label} ${input.priceLabel} · 触及 ${pct(input.pTouch)} · 守住 ${pct(input.pHold)}`,
    axisLabelVisible: !historical,
  };
}

export interface ChartZoneCandidate {
  center: number;
  zone_type: 'support' | 'resistance';
  history?: boolean;
}

/** Keep nearby current levels visible on both sides and use history only as a fallback. */
export function selectChartZones<T extends ChartZoneCandidate>(zones: T[], price: number): T[] {
  const selected: T[] = [];
  const perSide = 2;
  for (const type of ['support', 'resistance'] as const) {
    const side = zones.filter((zone) => zone.zone_type === type);
    const nearest = (a: T, b: T) => Math.abs(a.center - price) - Math.abs(b.center - price);
    const current = side.filter((zone) => !zone.history).sort(nearest);
    const history = side.filter((zone) => zone.history).sort(nearest);
    const visible = current.slice(0, perSide);
    visible.push(...history.slice(0, Math.max(0, perSide - visible.length)));
    selected.push(...visible);
  }
  return selected.sort((a, b) => Math.abs(a.center - price) - Math.abs(b.center - price));
}
