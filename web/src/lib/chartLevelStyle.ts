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
  pTouch: number | null;
  pHold: number | null;
}): ChartZoneLineStyle {
  const historical = input.history;
  const color = input.type === 'support'
    ? `rgba(46,211,160,${ZONE_OPACITY})`
    : `rgba(255,95,109,${ZONE_OPACITY})`;
  const pct = (v: number | null) => v === null ? '—' : `${Math.round(v * 100)}%`;
  return {
    color,
    width: 2,
    title: historical ? '' : `触及 ${pct(input.pTouch)} · 守住 ${pct(input.pHold)}`,
    axisLabelVisible: !historical,
  };
}
