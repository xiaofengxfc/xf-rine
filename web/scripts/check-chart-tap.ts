/**
 * 离线体检：点按命中（web/src/lib/chartTap.ts）。
 *
 * 这块逻辑管的是「手机点一下 K 线，读数是不是那一根」。
 * 写错了的表现很具体：点空白也弹出读数、手指偏一点就落到隔壁那根上、窄屏上点不准 ——
 * 所以这里把几种真实形状钉住，跑一遍就知道有没有改坏。
 *
 * 注意点按**不看纵向**：箭头画在 K 线下方，但它是这一根的标记 ——
 * 点在 K 线身上和点在箭头上读到的必须是同一根。
 *
 * 用法：pnpm check:chart-tap
 */
import { hitTestTap, measureSpacing, nearestIndex, type TapGeometry } from '../src/lib/chartTap.ts';

const BASE = 1_700_000_000;
const STEP = 900;

/** 造一段假行情：第 i 根时间 = BASE + i*900。点按只用到时间这一列 */
const bars = (n: number) => ({
  time: Array.from({ length: n }, (_, i) => BASE + i * STEP),
});

/**
 * 一张画布：左边留 20px，一根占 barSpacing 像素。
 * 手机上默认视图（一屏 110 根左右）是一根 7.5px。
 */
const geometry = (n: number, barSpacing = 7.5): TapGeometry => ({
  count: n,
  indexToX: (index: number) => {
    if (index < 0 || index > n - 1) return null;
    return 20 + index * barSpacing;
  },
});

let failed = 0;
let total = 0;
function check(name: string, got: unknown, want: unknown): void {
  total += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log((ok ? 'ok  ' : 'FAIL ') + name
    + (ok ? '' : '\n     得到 ' + JSON.stringify(got) + '\n     期望 ' + JSON.stringify(want)));
}

/** 第 i 根的中心 */
const xOf = (i: number, n: number) => geometry(n).indexToX(i) as number;

// ---- 1. 点在 K 线正中间：就是那一根 ----
{
  const n = 110;
  const i = 40;
  const hit = hitTestTap(xOf(i, n) + 0.5, bars(n), geometry(n));
  check('点在正中间命中这一根', hit?.index, i);
}

// ---- 2. 偏一点也还算这一根（吸附半径 0.75 根）----
{
  const n = 110;
  const i = 40;
  const hit = hitTestTap(xOf(i, n) + 3.75, bars(n), geometry(n));
  check('偏半根仍算这一根', hit?.index, i);
  const next = hitTestTap(xOf(i, n) + 6.75, bars(n), geometry(n));
  check('偏到 0.9 根落到下一根', next?.index, i + 1);
}

// ---- 3. 点在最右边空白里（未来区）：不算点中 ----
{
  const n = 110;
  const lastX = xOf(n - 1, n);
  check('点右侧留白不算点中', hitTestTap(lastX + 20, bars(n), geometry(n)), null);
}

// ---- 4. 纵向不参与判断：同一根，点高的地方和点低的地方都该命中 ----
{
  const n = 110;
  const i = 40;
  const x = xOf(i, n) + 0.5;
  check('点在 K 线身上（高处）：命中这一根', hitTestTap(x, bars(n), geometry(n), {})?.index, i);
}

// ---- 5. 一根很密：吸附半径按最小间距兜住 ----
{
  const n = 300;
  const g = geometry(n, 2.2);
  const i = 150;
  const hit = hitTestTap((g.indexToX(i) as number) + 0.4, bars(n), g);
  check('2.2px 一根时点正中仍然命中', hit?.index, i);
  const near = hitTestTap((g.indexToX(i) as number) + 0.9, bars(n), g);
  check('密排时偏不到 1px 仍取最近', near?.index, i);
}

// ---- 6. 没数据 / 坐标不是数：不命中 ----
check('没有 K 线：不命中', hitTestTap(10, { time: [] }, geometry(0)), null);
check('坐标不是数：不命中', hitTestTap(Number.NaN, bars(10), geometry(10)), null);

// ---- 7. 二分找最近下标 ----
{
  const n = 110;
  const g = geometry(n);
  // nearestIndex 是 lowerBound：第一个不比手指小的下标。真选「最近那根」的是 hitTestTap
  check('二分：落在两根之间给右边那根', nearestIndex(xOf(55, n) + 0.5, n, g.indexToX), 56);
  const hit = hitTestTap(xOf(55, n) + 0.5, bars(n), g);
  check('二分之后按距离取最近', hit?.index, 55);
  check('二分：回到最早那根', nearestIndex(-100, n, g.indexToX), 0);
  check('二分：越过最后那根', nearestIndex(9999, n, g.indexToX), n - 1);
}

// ---- 8. 量间距：两端只剩一侧邻居时也不炸 ----
{
  const n = 110;
  const g = geometry(n);
  check('中间的间距', Math.round(measureSpacing(50, n, g.indexToX, 8) * 10) / 10, 7.5);
  check('最早一根只有右侧邻居', Math.round(measureSpacing(0, n, g.indexToX, 8) * 10) / 10, 7.5);
  check('最后一根只有左侧邻居', Math.round(measureSpacing(n - 1, n, g.indexToX, 8) * 10) / 10, 7.5);
  check('只有一根：退回最小间距', measureSpacing(0, 1, g.indexToX, 8), 8);
}

if (failed > 0) {
  console.error('\n✗ ' + failed + ' 项失败，' + (total - failed) + ' 项通过');
  process.exit(1);
}
console.log('\n✓ 点按命中全部通过（' + total + ' 项）');
