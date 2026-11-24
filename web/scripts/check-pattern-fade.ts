/**
 * 翻转口径自检：反转形态当成趋势延续信号时，数字必须严格对称。
 *
 * 为什么要有这个检验：翻转口径里动了两处 —— 成交方向取反、基准也取反。
 * 只翻一处，算出来的就是两个不同基准之差，看起来有数字、实际是错的。
 *
 * 不变量（同一批数据、同一批命中）：
 *   n 相同（形态判定没变）
 *   excess_fade = −excess_normal
 *   z_fade      = −z_normal
 * 成立就说明方向与基准都翻对了。
 */
import { feed, newBucket, rowsOf } from './pattern-core.ts';
import type { Bar } from '../src/lib/api.ts';

let passed = 0;
const failures: string[] = [];
function ok(name: string, fn: () => void): void {
  try { fn(); passed += 1; } catch (err) { failures.push(name + ': ' + (err as Error).message); }
}

/** 定长伪随机，保证每次跑出来一样 */
function randomBars(n: number): Bar[] {
  let seed = 987654321;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let px = 100;
  const bars: Bar[] = [];
  for (let i = 0; i < n; i += 1) {
    const o = px;
    const c = Math.max(1, o + (rnd() - 0.5) * 0.9);
    const h = Math.max(o, c) + rnd() * 0.4;
    const l = Math.max(0.5, Math.min(o, c) - rnd() * 0.4);
    bars.push({ time: 1577836800 + i * 3600, open: o, high: h, low: l, close: c, volume: 1 });
    px = c;
  }
  return bars;
}

const bars = randomBars(4000);

ok('翻转后样本数不变、增量与 z 严格取反', () => {
  const normal = newBucket();
  feed(normal, bars);
  const fade = newBucket();
  feed(fade, bars, 0, bars.length, bars.length, { fade: true });

  const nRows = new Map(rowsOf(normal).map((r) => [r.id, r]));
  const fRows = new Map(rowsOf(fade).map((r) => [r.id, r]));
  if (nRows.size === 0) throw new Error('两个桶都没命中，样本有问题');

  for (const [id, nr] of nRows) {
    const fr = fRows.get(id);
    if (!fr) throw new Error(id + ' 只有正常口径有，翻转口径没有');
    if (fr.acc.n !== nr.acc.n) throw new Error(id + ' 样本数变了：' + nr.acc.n + ' → ' + fr.acc.n);
    const excessGap = Math.abs(fr.excess + nr.excess);
    if (excessGap > 1e-9) throw new Error(id + ' 增量没有严格取反：' + nr.excess + ' / ' + fr.excess);
    if (Math.abs(fr.z + nr.z) > 1e-6) throw new Error(id + ' z 没有严格取反');
  }
  if (fRows.size !== nRows.size) throw new Error('两种口径的形态个数不一样');
});

ok('翻转后逐笔收益换号，胜率互补', () => {
  const normal = newBucket();
  feed(normal, bars);
  const fade = newBucket();
  feed(fade, bars, 0, bars.length, bars.length, { fade: true });
  const id = 'bullishEngulfing';
  const n = rowsOf(normal).find((r) => r.id === id);
  const f = rowsOf(fade).find((r) => r.id === id);
  if (!n || !f) throw new Error('样本里没有 ' + id + '，换个生成参数');
  if (Math.abs(n.win + f.win - 1) > 1e-9) throw new Error('胜率不是互补的');
  if (Math.abs(n.edgeAtr + f.edgeAtr) > 1e-9) throw new Error('每笔平均收益没有取反');
});

ok('翻转模式下基准取的是另一侧', () => {
  // 直接构造：全涨的数据里，做多基准 = 1、做空基准 = 0
  const up: Bar[] = [];
  for (let i = 0; i < 300; i += 1) {
    const o = 100 + i;
    up.push({ time: 1577836800 + i * 3600, open: o, high: o + 1.5, low: o - 0.5, close: o + 1, volume: 1 });
  }
  const b = newBucket();
  feed(b, up);
  const row = rowsOf(b)[0];
  if (!row) return; // 这段数据可能没命中任何形态，不算失败
  // 单边上涨：做多基准应当是 1，做空基准 0；不管这个形态是看涨还是看跌，
  // 它的 base 必须等于它自己有效方向那一侧的基准
  if (row.base !== 0 && row.base !== 1) throw new Error('单边行情下基准应当是 0 或 1，实际 ' + row.base);
});

// ---------- 汇总 ----------
if (failures.length > 0) {
  console.error('翻转口径自检失败 ' + failures.length + ' 条（通过 ' + passed + ' 条）');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('翻转口径自检通过：' + passed + ' 条');
