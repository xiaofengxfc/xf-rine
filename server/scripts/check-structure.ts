/**
 * 命令行体检：结构状态（structure.ts）与多周期一致性（applyConfluence）。
 * 用法： pnpm -F server exec tsx scripts/check-structure.ts BTC_USDT 15m
 *
 * 这一层最容易出的两种错都很难靠眼睛看出来：
 *   1. 用了未来数据（回测好看、实盘不灵）——所以专门验「摆动点右侧必须已经有 k 根」；
 *   2. 趋势判反（上升说成下降）——所以每个方向都用明确构造的折线验一遍。
 */
import {
  applyConfluence, detectLevels, pivots, resampleBars, type Bar, type Level,
} from '../src/levels.js';
import { analyzeStructure } from '../src/structure.js';

const failures: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };
const T0 = 1_700_000_000;

/** 折线路径：每段走 steps 根，端点就是拐点。这样每个拐点都是窗口内唯一的极值 */
function path(points: [number, number][]): Bar[] {
  const closes: number[] = [points[0]![0]];
  for (let i = 1; i < points.length; i++) {
    const from = closes[closes.length - 1]!;
    const to = points[i]![0];
    const steps = points[i]![1];
    for (let s = 1; s <= steps; s++) closes.push(from + ((to - from) * s) / steps);
  }
  const bars: Bar[] = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i]!;
    // 实体为 0：如果让开盘等于上一根收盘，峰两侧两根的高点会并成同一个数，
    // 摆动点判定用的是严格极值，一相等就不算拐点了 —— 那是测试数据的问题，不是判定的问题
    bars.push({ time: T0 + i * 900, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 });
  }
  return bars;
}

// ---- 1) 上升：更高的高点 + 更高的低点 ----
{
  const bars = path([[100, 0], [104, 5], [101, 5], [107, 5], [103, 5], [105, 5]]);
  const s = analyzeStructure(bars);
  check(s.trend === 'up', '上升：该判成上升，得到 ' + s.trend);
  // 摆动点取的是影线的极值，不是收盘价：这里是收盘 107 再加 0.5 的上影
  check(s.lastHigh?.price === 107.5, '上升：最近的高点该是 107.5（影线），得到 ' + s.lastHigh?.price);
  check(s.lastLow?.price === 102.5, '上升：最近的低点该是 102.5（影线），得到 ' + s.lastLow?.price);
  check(s.event === null, '上升：收盘没破任何极值，不该报结构事件，得到 ' + (s.event && s.event.kind));
  check(s.note.includes('上升'), '上升：结论文案里没写上升：' + s.note);
}

// ---- 2) 下降：更低的高点 + 更低的低点 ----
{
  const bars = path([[110, 0], [106, 5], [109, 5], [103, 5], [107, 5], [105, 5]]);
  const s = analyzeStructure(bars);
  check(s.trend === 'down', '下降：该判成下降，得到 ' + s.trend);
  check(s.lastHigh?.price === 107.5, '下降：最近的高点该是 107.5，得到 ' + s.lastHigh?.price);
  check(s.lastLow?.price === 102.5, '下降：最近的低点该是 102.5，得到 ' + s.lastLow?.price);
  check(s.note.includes('下降'), '下降：结论文案里没写下降：' + s.note);
}

// ---- 3) 区间：高点和低点没有同向（这里两边都持平） ----
{
  const bars = path([[100, 0], [104, 5], [101, 5], [104, 6], [101, 5], [103, 5]]);
  const s = analyzeStructure(bars);
  check(s.trend === 'range', '区间：该判成区间，得到 ' + s.trend);
  check(s.rangePct !== null && s.rangePct >= 0 && s.rangePct <= 100, '区间：位置百分比越界：' + s.rangePct);
  check(s.zone !== null, '区间：位置算得出来，就该给出溢价/折价/中间');
}

// ---- 4) BOS：顺着上升趋势破掉前高 ----
{
  const bars = path([[100, 0], [104, 5], [101, 5], [107, 5], [103, 5], [110, 5]]);
  const s = analyzeStructure(bars);
  check(s.trend === 'up', 'BOS：这一段本该是上升，得到 ' + s.trend);
  check(s.event?.kind === 'BOS', 'BOS：顺趋势破前高该报 BOS，得到 ' + s.event?.kind);
  check(s.event?.direction === 'up', 'BOS：方向该向上，得到 ' + s.event?.direction);
  check(s.event?.price === 107.5, 'BOS：该记被破掉的那个前高 107.5，得到 ' + s.event?.price);
}

// ---- 5) CHoCH：上升途中跌破前低 ----
{
  const bars = path([[100, 0], [104, 5], [101, 5], [107, 5], [103, 5], [110, 5], [99, 6]]);
  const s = analyzeStructure(bars);
  check(s.trend === 'up', 'CHoCH：破位之前的结构是上升，得到 ' + s.trend);
  check(s.event?.kind === 'CHoCH', 'CHoCH：逆着上升破前低该报 CHoCH，得到 ' + s.event?.kind);
  check(s.event?.direction === 'down', 'CHoCH：方向该向下，得到 ' + s.event?.direction);
  check(s.event?.price === 102.5, 'CHoCH：该记被破掉的那个前低 102.5，得到 ' + s.event?.price);
}

// ---- 6) no-lookahead：摆动点右边必须已经有 k 根，加多少未来数据都不改前面的点 ----
{
  const bars = path([[100, 0], [104, 5], [101, 5], [107, 5], [103, 5], [110, 5]]);
  const s = analyzeStructure(bars, { swing: 3 });
  const limit = bars.length - 1 - 3;
  check((s.lastHigh?.index ?? 0) <= limit, 'no-lookahead：最近的高点用了右边不足 3 根的 K 线');
  check((s.lastLow?.index ?? 0) <= limit, 'no-lookahead：最近的低点用了右边不足 3 根的 K 线');

  const cut = bars.length - 8;
  const early = pivots(bars, 3).filter((p) => p.index < cut);
  const future = path([[120, 4], [90, 4]]);
  const extended = [...bars, ...future.map((b, i) => ({ ...b, time: T0 + (bars.length + i) * 900 }))];
  const after = pivots(extended, 3).filter((p) => p.index < cut);
  check(JSON.stringify(early) === JSON.stringify(after), 'no-lookahead：加了后面的数据，前面的摆动点变了');
}

// ---- 7) 重采样：开高低收量时间都要对，除不尽的最后一组丢掉 ----
{
  const bars = path([[100, 0], [104, 3], [101, 3]]);
  const r = resampleBars(bars, 4);
  check(r.length === Math.floor(bars.length / 4), '重采样：根数不对（末尾不足一组要丢掉），得到 ' + r.length + ' / 原始 ' + bars.length);
  const g = bars.slice(0, 4);
  check(r[0]!.open === g[0]!.open, '重采样：开盘该取第一根');
  check(r[0]!.close === g[3]!.close, '重采样：收盘该取最后一根');
  check(r[0]!.high === Math.max(...g.map((b) => b.high)), '重采样：最高价不对');
  check(r[0]!.low === Math.min(...g.map((b) => b.low)), '重采样：最低价不对');
  check(r[0]!.volume === g.reduce((s2, b) => s2 + b.volume, 0), '重采样：成交量该累加');
  check(r[0]!.time === g[0]!.time, '重采样：时间该取这一组的第一根');
  check(resampleBars(bars, 1).length === bars.length, '重采样：factor 1 应该原样返回');
}

// ---- 8) 多周期一致：认上的加权，没认上的一个数都不动 ----
{
  const mk = (price: number, strength: number): Level => ({
    price, role: 'support', strength, touches: 3, failures: 0, volumeRatio: 0.5,
    distancePct: 0, lastTouch: T0, zoneLow: price * 0.999, zoneHigh: price * 1.001,
  });
  const fine = [mk(100, 40), mk(200, 80)];
  const coarse = [mk(100.2, 50)];
  const out = applyConfluence(fine, coarse, 1, 100);
  check(out.length === fine.length, '一致性：打分不该增删条目');
  const hit = out.find((l) => Math.abs(l.price - 100) < 1e-9)!;
  const miss = out.find((l) => Math.abs(l.price - 200) < 1e-9)!;
  check(hit.confluence === 2, '一致性：更粗周期也认的这条该标成 2 级');
  check(hit.strength > 40, '一致性：认上了强度该更高，得到 ' + hit.strength);
  check(miss.confluence === 1, '一致性：没认上的该标成 1 级');
  check(miss.strength === 80, '一致性：没认上的强度一个数都不该动，得到 ' + miss.strength);
  check(applyConfluence(fine, [], 1, 100).every((l) => l.strength === (l.price === 100 ? 40 : 80)), '一致性：没有粗周期数据时不该改强度');
}

// ---- 9) 确定性 ----
{
  const bars = path([[100, 0], [104, 5], [101, 5], [107, 5], [103, 5], [110, 5]]);
  check(JSON.stringify(analyzeStructure(bars)) === JSON.stringify(analyzeStructure(bars)), '确定性：两次调用结果不同');
}

console.log('自检（构造数据）：');
if (failures.length === 0) {
  console.log('  全部通过（上升 / 下降 / 区间 / BOS / CHoCH / no-lookahead / 重采样 / 多周期一致 / 确定性）');
} else {
  for (const f of failures) console.log('  ✗ ' + f);
}

// ---- 10) 真实行情跑一遍（没有网络就跳过） ----
const contract = process.argv[2] ?? 'BTC_USDT';
const interval = process.argv[3] ?? '15m';
try {
  const res = await fetch(
    'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=' + contract
      + '&interval=' + interval + '&limit=500',
  );
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const raw = (await res.json()) as { t: number; o: string; h: string; l: string; c: string; v: number }[];
  const all: Bar[] = raw.map((c) => ({
    time: Number(c.t), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v),
  }));
  const closed = all.slice(0, -1);
  const s = analyzeStructure(closed, { swing: 3 });
  const fine = detectLevels(closed, {});
  const coarse = detectLevels(resampleBars(closed, 4), { pivotWindow: 3, maxLevels: 8 });
  const weighted = applyConfluence(fine.levels, coarse.levels, fine.atr, closed[closed.length - 1]!.close);
  const both = weighted.filter((l) => l.confluence === 2).length;
  console.log('');
  console.log(contract + ' ' + interval + '  结构：' + s.note);
  console.log('  价位 ' + fine.levels.length + ' 条，其中 ' + both + ' 条在 4 倍周期上也成立');
  for (const l of weighted) {
    console.log('    ' + l.price.toFixed(2).padStart(10) + '  ' + (l.role === 'support' ? '支撑' : '阻力')
      + '  强度 ' + Math.round(l.strength) + (l.confluence === 2 ? ' ×2' : ''));
  }
} catch (e) {
  console.log('');
  console.log('（没有网络，跳过真实数据那一段：' + (e as Error).message + '）');
}

if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
}
process.exit(failures.length === 0 ? 0 : 1);
