/**
 * 纯函数自检：平价 K 线怎么撑开、尾部怎么补、无成交占比怎么算。
 *
 * 用法： pnpm check:paint
 * 这几条都是纯函数，拿构造的数据就能验，不需要网络也不需要起服务。
 */
import {
  FLAT_BODY_PX, FLAT_WICK_PX,
  INTERVAL_SEC, isFlatBar, isNoTradeBar, mergeNewer, mergeOlder, normalizeBars, paintBars,
  paintBarsIncrementally, scaleBucket, snapTime, sparseStats, upsertBar,
  type Bar,
} from '../src/lib/candles.ts';
import { backfill } from '../src/lib/backfill.ts';
import { fmtVolume } from '../src/lib/format.ts';

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

// ---- 周期吸附 ----
ok('周期吸附：不在网格上的推送时间归到周期起点', () => {
  const t = 20 * 3600 + 29 * 60;
  eq(snapTime(t, 300), 20 * 3600 + 25 * 60, '5m 的 20:29 → 20:25');
  eq(snapTime(1234.9, 60), 1200, '1m 向下取整');
  eq(snapTime(10, 0), 10, 'step 为 0 时原样返回');
});

ok('mergeNewer：值没变的根保留原对象（避免图表/形态扫描整段重算）', () => {
  const prev = [bar(60, 10, 11, 9, 10.5), bar(120, 10.5, 11, 10, 10.8)];
  const page = prev.map((b) => ({ ...b }));
  if (mergeNewer(prev, page, 100).bars !== prev) throw new Error('没有变化时应返回原数组');
  const changed = prev.map((b) => ({ ...b }));
  changed[1] = { ...changed[1]!, close: changed[1]!.close + 1 };
  const out = mergeNewer(prev, changed, 100);
  if (out.bars[0] !== prev[0]) throw new Error('没变的根被换掉了');
  if (out.bars[1] === prev[1]) throw new Error('变了的根没有换新对象');
  if (out.patched !== 1) throw new Error('patched 应为 1');
});

// ---- paintBars ----
const sample: Bar[] = [
  bar(60, 10, 11, 9, 10.5, 20),      // 正常
  bar(120, 10.5, 10.5, 10.5, 10.5, 0), // 零成交平价
  bar(180, 10.5, 10.5, 10.5, 10.5, 4), // 平价但有成交（同一价位撮合）
  bar(240, 10.5, 12, 10, 11, 30),
];

ok('paintBars：条数、顺序、成交量都不动', () => {
  const out = paintBars(sample, 0.01);
  eq(out.length, sample.length, '条数');
  eq(out.map((b) => b.time), sample.map((b) => b.time), '时间序列');
  eq(out.map((b) => b.volume), sample.map((b) => b.volume), '成交量');
});

ok('paintBars：平价线只撑形状，中心仍钉在真实收盘价上', () => {
  const out = paintBars(sample, 0.01);
  if (out.length !== sample.length) throw new Error('条数变了');
  for (let i = 0; i < out.length; i += 1) {
    const src = sample[i]!;
    const painted = out[i]!;
    if (!isFlatBar(src)) {
      eq(painted, { ...src, flat: false }, `第 ${i} 根正常 K 线不该动`);
      continue;
    }
    // 平价线：开收和影线都被撑开了，但中心还是那个真实成交价
    if (Math.abs((painted.open + painted.close) / 2 - src.close) > 1e-12) throw new Error('实体中心跑掉了');
    if (Math.abs((painted.high + painted.low) / 2 - src.close) > 1e-12) throw new Error('影线中心跑掉了');
    eq(painted.realClose, src.close, '原始收盘价留在 realClose 上');
  }
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

/**
 * 像素撑开：这一批用例守的是「K 线之间断连」那个毛病。
 *
 * 撑半个最小变动价在多数合约上不到一个像素，一根平价线就只剩一行小横杠。
 * 量得出屏幕比例时，实体和影线一律按像素撑，两根之间才连得上。
 */
const pxPerPx = 0.001; // 一个像素值 0.001 个价格

ok('paintBars：量得出像素时实体和影线都按像素撑开', () => {
  const out = paintBars(sample, 0.01, pxPerPx);
  for (const b of out) {
    if (!(b.high > b.low)) throw new Error(`${b.time} 还是画不出来`);
  }
  const flat = out[1]!;
  const body = flat.close - flat.open;
  const wick = flat.high - flat.low;
  if (Math.abs(body - FLAT_BODY_PX * pxPerPx) > 1e-9) throw new Error(`实体高度应是 ${FLAT_BODY_PX}px：${body}`);
  if (Math.abs(wick - FLAT_WICK_PX * pxPerPx) > 1e-9) throw new Error(`影线高度应是 ${FLAT_WICK_PX}px：${wick}`);
  // 撑开之后实体仍然以真实收盘价为中心：位置不许挪
  const mid = (flat.high + flat.low) / 2;
  if (Math.abs(mid - 10.5) > 1e-9) throw new Error(`平价线中心跑掉了：${mid}`);
});

ok('paintBars：撑开过的收盘价另存一份，折线要用真实的', () => {
  const out = paintBars(sample, 0.01, pxPerPx);
  eq(out[1]!.realClose, 10.5, '平价线原始收盘价');
  if (out[1]!.close === out[1]!.realClose) throw new Error('撑开之后 close 应当已经不同');
  eq(out[0]!.realClose, undefined, '正常 K 线不需要另存');
});

ok('paintBars：没有像素信息时退回按最小变动价撑开', () => {
  const out = paintBars(sample, 0.01, 0);
  const flat = out[1]!;
  if (Math.abs((flat.high - flat.low) - 0.01) > 1e-12) throw new Error('应撑开一个最小变动价');
  // 实体跟着撑开一半，位置仍以真实收盘价为中心
  if (Math.abs((flat.open + flat.close) / 2 - 10.5) > 1e-12) throw new Error('实体中心跑掉了');
  if (!(flat.close > flat.open)) throw new Error('实体要有高度，否则又只剩一行小横杠');
  eq(flat.realClose, 10.5, '原始收盘价留在 realClose 上');
});

ok('scaleBucket：差一成不换档，翻倍才换档', () => {
  eq(scaleBucket(0.001), scaleBucket(0.0011), '差 10% 同一档');
  if (scaleBucket(0.001) === scaleBucket(0.002)) throw new Error('翻倍应换档');
  eq(scaleBucket(0), 0, '量不出来算 0 档');
  eq(scaleBucket(Number.NaN), 0, 'NaN 算 0 档');
});

ok('增量撑开：像素当量变了要整段重算', () => {
  const previous = paintBars(sample, 0.01, pxPerPx);
  const incremental = paintBarsIncrementally(sample, 0.01, pxPerPx * 2, {
    bars: sample, tick: 0.01, px: pxPerPx, painted: previous,
  });
  eq(incremental, paintBars(sample, 0.01, pxPerPx * 2), '与整段重算结果一致');
  if (incremental[1] === previous[1]) throw new Error('像素当量变了却复用了旧的撑开结果');
});

ok('增量撑开：实时更新时复用未变化的历史 K 线', () => {
  const previous = paintBars(sample, 0.01);
  const next = sample.slice();
  next[next.length - 1] = bar(240, 10.5, 12.5, 10, 11.5, 32);
  const incremental = paintBarsIncrementally(next, 0.01, 0, { bars: sample, tick: 0.01, px: 0, painted: previous });
  eq(incremental, paintBars(next, 0.01), '与整段重算结果一致');
  if (incremental[0] !== previous[0] || incremental[1] !== previous[1]) {
    throw new Error('未变化的 K 线应复用转换结果');
  }
});

ok('增量撑开：最小变动价变化时重新计算全部 K 线', () => {
  const previous = paintBars(sample, 0.01);
  const incremental = paintBarsIncrementally(sample, 0.1, 0, { bars: sample, tick: 0.01, px: 0, painted: previous });
  eq(incremental, paintBars(sample, 0.1), '与整段重算结果一致');
  if (incremental[1] === previous[1] || incremental[1]!.high === previous[1]!.high) {
    throw new Error('最小变动价变化后平价 K 线应重新撑开');
  }
});

ok('增量撑开：追加新 K 线时复用全部已有 K 线', () => {
  const previous = paintBars(sample, 0.01);
  const next = [...sample, bar(300, 11, 12, 10.5, 11.5, 26)];
  const incremental = paintBarsIncrementally(next, 0.01, 0, { bars: sample, tick: 0.01, px: 0, painted: previous });
  eq(incremental, paintBars(next, 0.01), '与整段重算结果一致');
  if (incremental.slice(0, sample.length).some((item, index) => item !== previous[index])) {
    throw new Error('追加 K 线后已有转换结果应复用');
  }
});

ok('增量撑开：滑动数据窗口时复用未变化的重叠 K 线', () => {
  const previous = paintBars(sample, 0.01);
  const next = [sample[1]!, sample[2]!, sample[3]!, bar(300, 11, 12, 10.5, 11.5, 26)];
  const incremental = paintBarsIncrementally(next, 0.01, 0, { bars: sample, tick: 0.01, px: 0, painted: previous });
  eq(incremental, paintBars(next, 0.01), '与整段重算结果一致');
  if (incremental[0] !== previous[1] || incremental[2] !== previous[3]) {
    throw new Error('滑动窗口中未变化的 K 线应复用转换结果');
  }
});

ok('增量撑开：补入更早历史时复用已有 K 线', () => {
  const previous = paintBars(sample, 0.01);
  const older = bar(30, 8, 9, 7, 8.5);
  const next = [older, ...sample];
  const incremental = paintBarsIncrementally(next, 0.01, 0, { bars: sample, tick: 0.01, px: 0, painted: previous });
  eq(incremental, paintBars(next, 0.01), '与整段重算结果一致');
  if (incremental[1] !== previous[0] || incremental[2] !== previous[1]) {
    throw new Error('补历史后已有 K 线应复用转换结果');
  }
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

ok('mergeNewer：原始量不变时也更新成交额', () => {
  const previous = [{ ...base[2]!, turnover: 100 }];
  const next = [{ ...base[2]!, turnover: 125.5 }];
  const merged = mergeNewer(previous, next, 100);
  eq(merged.patched, 1, '成交额变化计入补丁');
  eq(merged.bars[0]!.volume, base[2]!.volume, '原始成交量不变');
  eq(merged.bars[0]!.turnover, 125.5, '更新计价币成交额');
});

ok('成交额格式：小数不取整，较大值缩写', () => {
  eq(fmtVolume(0.0276), '0.0276', '小数成交额');
  eq(fmtVolume(1_234_567), '1.23M', '大额缩写');
});

ok('实时缓冲：按时间更新、插入并保留最新容量', () => {
  const pending = [bar(120, 2, 2, 2, 2)];
  upsertBar(pending, bar(120, 2, 3, 1, 2.5), 3);
  upsertBar(pending, bar(180, 3, 3, 3, 3), 3);
  upsertBar(pending, bar(60, 1, 1, 1, 1), 3);
  eq(pending.map((item) => item.time), [60, 120, 180], '有序且无重复');
  eq(pending[1]!.close, 2.5, '同一根应用最新推送');
  upsertBar(pending, bar(240, 4, 4, 4, 4), 3);
  eq(pending.map((item) => item.time), [120, 180, 240], '超出容量时保留最新 K 线');
});

ok('mergeOlder：容量不足时补入最靠近现有数据的历史', () => {
  const current = [bar(180, 3, 3, 3, 3), bar(240, 4, 4, 4, 4), bar(300, 5, 5, 5, 5)];
  const page = [
    bar(0, 1, 1, 1, 1), bar(60, 2, 2, 2, 2), bar(120, 3, 3, 3, 3),
    ...current,
  ];
  const merged = mergeOlder(current, page, 5);
  eq(merged.bars.map((item) => item.time), [60, 120, 180, 240, 300], '保留已有数据并填满剩余容量');
  eq([merged.added, merged.full], [2, true], '新增数量和上限标记');
});

try {
  const result = await backfill({
    bars: [bar(180, 3, 3, 3, 3), bar(240, 4, 4, 4, 4), bar(300, 5, 5, 5, 5)],
    maxBars: 5,
    fetchPage: async () => ({
      bars: [bar(0, 1, 1, 1, 1), bar(60, 2, 2, 2, 2), bar(120, 3, 3, 3, 3)],
      exhausted: true,
    }),
  });
  eq(result.bars.map((item) => item.time), [60, 120, 180, 240, 300], '补入最近的两根历史');
  eq(result.stopped, 'full', '到本地上限时标记为 full');
  passed += 1;
} catch (err) {
  failures.push(`backfill：容量边缘优先保留已显示数据: ${(err as Error).message}`);
}

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
