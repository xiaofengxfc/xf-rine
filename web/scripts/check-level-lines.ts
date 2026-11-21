/** Regression checks for current and historical support/resistance drawing. */
import { chartZoneLineStyle, selectChartZones } from '../src/lib/chartLevelStyle.ts';

let failures = 0;
function check(name: string, ok: boolean): void {
  if (ok) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}
for (const type of ['support', 'resistance'] as const) {
  const label = type === 'support' ? '支撑' : '阻力';
  const current = chartZoneLineStyle({ type, history: false, priceLabel: '12,345.6', pTouch: 0.62, pHold: 0.73 });
  const history = chartZoneLineStyle({ type, history: true, priceLabel: '12,345.6', pTouch: 0.62, pHold: 0.73 });
  check(type + ' 历史线与当前线颜色/粗细一致', current.color === history.color && current.width === history.width);
  check(type + ' 历史线保留实线并隐藏文字/轴价签', history.title === '' && !history.axisLabelVisible);
  check(type + ' 当前线显示方向、价格、触及与守住信息', current.title === `${label} 12,345.6 · 触及 62% · 守住 73%` && current.axisLabelVisible);
  check(type + ' 使用足够不透明的颜色', Number(current.color.match(/,([0-9.]+)\)$/)?.[1] ?? 0) >= 0.9);
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
