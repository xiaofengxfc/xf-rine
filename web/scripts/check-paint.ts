/**
 * 纯函数自检：平价 K 线怎么撑开、尾部怎么补、无成交占比怎么算。
 *
 * 用法： pnpm check:paint
 * 这几条都是纯函数，拿构造的数据就能验，不需要网络也不需要起服务。
 */
import {
  INTERVAL_SEC, isFlatBar, isNoTradeBar, mergeNewer, normalizeBars, paintBars, sparseStats,
  type Bar,
} from '../src/lib/candles.ts';

const bar = (time: number, o: number, h: number, l: number, c: number, v = 1): Bar => (
  { time, open: o, high: h, low: l, close: c, volume: v }
);

let passed = 0;
const failures: string[] = [];
function ok(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
  }
}
const eq = (a: unknown, b: unknown, what: string): void => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${what} 期望 ${sb}，实际 ${sa}`);
};

// ---- 平价 / 无成交 ----
ok('平价 K 线：high === low', () => {
  if (!isFlatBar(bar(60, 5, 5, 5, 5))) throw new Error('开收高低全相等应是平价');
  if (isFlatBar(bar(60, 5, 6, 5, 5))) throw new Error('有影线不是平价');
  // 零区间就是零区间：哪怕收盘价跑到区间外面（坏数据），也照样按平价撑开 ——
  // 先让它可见，总比默默从图上消失强
  if (!isFlatBar(bar(60, 5, 5, 5, 5.1))) throw new Error('零区间一律算平价');
});

ok('无成交：平价 + 零量 + 开收相等', () => {
  if (!isNoTradeBar(bar(60, 5, 5, 5, 5, 0))) throw new Error('零成交平价应算无成交');
  if (isNoTradeBar(bar(60, 5, 5, 5, 5, 3))) throw new Error('有量就不是无成交');
  if (isNoTradeBar(bar(60, 5, 6, 5, 5, 0))) throw new Error('有影线不是无成交');
});

// ---- paintBars ----
const sample: Bar[] = [
  bar(60, 10, 11, 9, 10.5, 20),      // 正常
  bar(120, 10.5, 10.5, 10.5, 10.5, 0), // 零成交平价
  bar(180, 10.5, 10.5, 10.5, 10.5, 4), // 平价但有成交（同一价位撮合）
  bar(240, 10.5, 12, 10, 11, 30),
];

ok('paintBars：条数、顺序、开盘量都不动', () => {
  const out = paintBars(sample, 0.01);
  eq(out.length, sample.length, '条数');
  eq(out.map((b) => b.time), sample.map((b) => b.time), '时间序列');
  eq(out.map((b) => [b.open, b.close, b.volume]), sample.map((b) => [b.open, b.close, b.volume]), '开收量');
});

ok('paintBars：平价线撑开后能画出来，且收盘价仍在高低之间', () => {
  const out = paintBars(sample, 0.01);
  for (const b of out) {
    if (!(b.high > b.low)) throw new Error(`${b.time} 还是画不出来`);
    if (b.close < b.low || b.close > b.high) throw new Error(`${b.time} 收盘价跑到影线外面`);
  }
  const flat = out[1]!;
  if (!flat.flat) throw new Error('平价线没标 flat');
  if (!(flat.high - flat.low >= 0.01 - 1e-12)) throw new Error(`撑开幅度不足一个最小变动价：${flat.high - flat.low}`);
});

ok('paintBars：正常 K 线的值一个都不改', () => {
  const out = paintBars(sample, 0.01);
  eq(out[0], { ...sample[0], flat: false }, '第一根');
  eq(out[3], { ...sample[3], flat: false }, '第四根');
});

ok('paintBars：没有最小变动价时也撑得开', () => {
  const out = paintBars([bar(60, 75.21, 75.21, 75.21, 75.21, 0)], 0);
  if (!(out[0]!.high > out[0]!.low)) throw new Error('没撑开');
});

ok('paintBars：不改调用方传进来的数组', () => {
  const before = JSON.stringify(sample);
  paintBars(sample, 0.01);
  eq(JSON.stringify(sample), before, '原始数据');
});

// ---- mergeNewer ----
const base: Bar[] = [bar(60, 1, 2, 1, 1.5), bar(120, 1.5, 2, 1, 1.8), bar(240, 1.8, 2, 1, 2)];
ok('mergeNewer：中间缺的那几根补进来', () => {
  const page = [bar(180, 1.8, 1.9, 1.7, 1.85), bar(240, 1.8, 2.1, 1, 2.05)];
  const m = mergeNewer(base, page, 100);
  eq(m.bars.map((b) => b.time), [60, 120, 180, 240], '时间序列');
  eq(m.added, 1, '补进来的根数');
  eq(m.patched, 1, '被覆盖的根数');
  eq(m.bars[3]!.close, 2.05, '最后一根要用新数据');
});

ok('mergeNewer：没有变化时原样返回同一个数组', () => {
  const m = mergeNewer(base, [base[2]!], 100);
  if (m.bars !== base) throw new Error('应该原样返回，别每次拷两万根');
  eq([m.added, m.patched], [0, 0], '改动计数');
});

ok('mergeNewer：空页不动数据', () => {
  const m = mergeNewer(base, [], 100);
  if (m.bars !== base) throw new Error('空页不该替换数组');
});

ok('mergeNewer：超上限从头部裁掉，右边全留', () => {
  const m = mergeNewer(base, [bar(300, 2, 3, 2, 2.5)], 3);
  eq(m.bars.map((b) => b.time), [120, 240, 300], '保留的时间序列');
});

ok('mergeNewer：更早的历史一根都不丢', () => {
  const m = mergeNewer(base, [bar(240, 1.8, 2.05, 1, 2.02)], 100);
  eq(m.bars.length, 3, '根数');
  eq(m.bars[0]!.time, 60, '最老一根');
});

// ---- 统计 ----
ok('sparseStats：平价 / 无成交 / 占比', () => {
  const s = sparseStats(sample);
  eq([s.count, s.flat, s.noTrade], [4, 2, 1], '计数');
  eq(Number(s.flatShare.toFixed(3)), 0.5, '占比');
  eq(sparseStats([]).flatShare, 0, '空数组不该算出 NaN');
});

// ---- 回归：原有整理逻辑 ----
ok('normalizeBars：乱序和重复时间照样收拢', () => {
  const dirty = [bar(120, 1, 1, 1, 1), bar(60, 1, 1, 1, 1), bar(120, 2, 2, 2, 2)];
  eq(normalizeBars(dirty), [bar(60, 1, 1, 1, 1), bar(120, 2, 2, 2, 2)], '整理结果');
});

ok('INTERVAL_SEC 和 Gate 的周期对得上', () => {
  eq([INTERVAL_SEC['1m'], INTERVAL_SEC['15m'], INTERVAL_SEC['4h'], INTERVAL_SEC['1d']], [60, 900, 14400, 86400], '步长');
});

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败，${passed} 项通过`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
