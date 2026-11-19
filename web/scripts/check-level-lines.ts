/** Regression checks for current and historical support/resistance drawing. */
import { chartZoneLineStyle } from '../src/lib/chartLevelStyle.ts';

let failures = 0;
function check(name: string, ok: boolean): void {
  if (ok) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}
for (const type of ['support', 'resistance'] as const) {
  const current = chartZoneLineStyle({ type, history: false, pTouch: 0.62, pHold: 0.73 });
  const history = chartZoneLineStyle({ type, history: true, pTouch: 0.62, pHold: 0.73 });
  check(type + ' 历史线与当前线颜色/粗细一致', current.color === history.color && current.width === history.width);
  check(type + ' 历史线保留实线并隐藏文字/轴价签', history.title === '' && !history.axisLabelVisible);
  check(type + ' 当前线显示触及与守住信息', current.title === '触及 62% · 守住 73%' && current.axisLabelVisible);
  check(type + ' 使用足够不透明的颜色', Number(current.color.match(/,([0-9.]+)\)$/)?.[1] ?? 0) >= 0.9);
}
if (failures) process.exit(1);
console.log('✓ 支撑阻力标注检查通过');
