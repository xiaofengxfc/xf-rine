/** Regression checks for current and historical support/resistance drawing. */
import { chartColors } from '../src/lib/theme.ts';
import { chartZoneLineStyle, selectChartZones } from '../src/lib/chartLevelStyle.ts';

const colors = chartColors('dark');

let failures = 0;
function check(name: string, ok: boolean): void {
  if (ok) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}

for (const type of ['support', 'resistance'] as const) {
  const label = type === 'support' ? '支撑' : '阻力';
  const base = { type, priceLabel: '12,345.6', pTouch: 0.62, pHold: 0.73, colors };
  const current = chartZoneLineStyle({ ...base, history: false });
  const history = chartZoneLineStyle({ ...base, history: true });

  check(label + ' 当前线与历史线同色同粗', current.color === history.color && current.width === history.width);
  check(label + ' 颜色取自当前色板',
    current.color === (type === 'support' ? colors.zoneSupport : colors.zoneResistance));
  check(label + ' 当前线实线、历史线虚线', !current.dashed && history.dashed);
  check(label + ' 历史线不写字、不挂轴签', history.title === '' && !history.axisLabelVisible);
  /**
   * 当前位只写「方向 + 价格」。
   * 概率（触及 / 守住）是档位带那一条的事 —— 图上一共四条线，每条都写字会把 K 线盖掉小半个面板。
   */
  check(label + ' 当前线写方向与价格，不写概率',
    current.title === `${label} 12,345.6` && current.axisLabelVisible);

  const secondary = chartZoneLineStyle({ ...base, history: false, primary: false });
  check(label + ' 非最近的那条不写字', secondary.title === '' && !secondary.axisLabelVisible);

  const compact = chartZoneLineStyle({ ...base, history: false, compactLabel: true });
  check(label + ' 紧凑标签只写方向', compact.title === label && compact.axisLabelVisible);
}

const candidates = [
  { center: 99, zone_type: 'support' as const },
  { center: 98, zone_type: 'support' as const },
  { center: 97, zone_type: 'support' as const },
  { center: 96, zone_type: 'support' as const, history: true },
  { center: 101, zone_type: 'resistance' as const },
  { center: 102, zone_type: 'resistance' as const },
  { center: 103, zone_type: 'resistance' as const },
  { center: 104, zone_type: 'resistance' as const, history: true },
];
const visible = selectChartZones(candidates, 100);
check('每侧最多两条，并保留最近的当前支撑和阻力',
  visible.length === 4
  && visible.filter((zone) => zone.zone_type === 'support').map((zone) => zone.center).join(',') === '99,98'
  && visible.filter((zone) => zone.zone_type === 'resistance').map((zone) => zone.center).join(',') === '101,102');

const historyFallback = selectChartZones([
  { center: 99, zone_type: 'support' as const },
  { center: 98, zone_type: 'support' as const, history: true },
  { center: 97, zone_type: 'support' as const, history: true },
], 100);
check('当前位不足时由最近历史位补足', historyFallback.map((zone) => zone.center).join(',') === '99,98');

if (failures) process.exit(1);
console.log('✓ 支撑阻力标注检查通过');
