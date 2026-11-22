import type { ChartColors } from './theme.ts';

/**
 * Shared appearance for current and historical support/resistance levels.
 *
 * 关键位是**标注**，不是行情：它和涨跌 K 线用同一套红绿，图上一眼分不出哪条是要紧的。
 * 所以这里统一压到 1px、浅一档、历史位改虚线，概率那些字也不再往图上塞 ——
 * 下面那条档位带里本来就写全了，图上写两遍只会把 K 线盖住。
 */
export interface ChartZoneLineStyle {
  color: string;
  width: 1 | 2;
  /** 虚线：历史位和「已经过去」的档位用它，和当下的位分开 */
  dashed: boolean;
  title: string;
  axisLabelVisible: boolean;
}

export function chartZoneLineStyle(input: {
  type: 'support' | 'resistance';
  history: boolean;
  priceLabel: string;
  pTouch: number | null;
  pHold: number | null;
  compactLabel?: boolean;
  /**
   * 这一侧离现价最近的那条。
   *
   * 只有它能往图上写字：四条都写的话，右边会叠起一堵彩色的标签墙，
   * 把 K 线压掉小半个面板。其余的靠颜色和轴上的价格指认就够了。
   */
  primary?: boolean;
  colors: ChartColors;
}): ChartZoneLineStyle {
  const historical = input.history;
  const color = input.type === 'support' ? input.colors.zoneSupport : input.colors.zoneResistance;
  const label = input.type === 'support' ? '支撑' : '阻力';
  const titled = !historical && input.primary !== false;
  return {
    color,
    width: 1,
    dashed: historical,
    title: titled ? (input.compactLabel ? label : `${label} ${input.priceLabel}`) : '',
    /**
     * 轴上的价格签也只给最近的那条。
     *
     * 四条线都挂轴签时，档位挨得近一点（叉盘上很常见）就会叠成一摞彩色方块，
     * 连底下真正的刻度 —— 比方说 59,200.0 —— 都被盖住，反而读不出价格。
     */
    axisLabelVisible: titled,
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
