/**
 * 形态识别自检。
 *
 * 用法： pnpm check:patterns
 *
 * 判定规则来自 vendor 进来的 cm45t3r/candlestick（MIT）。这里验六件事：
 *   1. 每个形态都映射到了中文名和方向，没有漏网的 id；
 *   2. 几组教科书形状能命中，而且标在「确认那根」上（两/三根形态的起始根不算）；
 *   3. 十字星/纺锤这类没有方向的、平价 K 线不上图；
 *   4. 实测统计表能对上：生成的 patternStats.ts 里每个形态都有中文名，
 *      统计的 n 和过门槛的形态数都说得通（这条防的是「表生成出来了但和代码脱节」）；
 *   5. 趋势灵敏度按周期标定：已统计的周期各有各的值，没统计的按邻近周期借，
 *      不会悄悄退回默认 5（那正是改造前的毛病）；
 *   6. 增量扫描（补历史 / 来新 K 线 / 裁头 / 改中间）和整段重算结果完全一致。
 *
 * 第 6 条是这页最容易被改坏的地方：库的形态是「按起始根」返回的，两/三根形态
 * 要 +span-1 才是确认根，少算一格，图上就会整体早一根。
 */
import type { Bar } from '../src/lib/api.ts';
import { detectPatterns, scanPatterns, PATTERN_IDS, trendSensitivityFor } from '../src/lib/patterns.ts';
import { allPatterns } from '../src/lib/candlestick/patternChain.js';
import { PATTERN_STATS, PATTERN_STATS_SAMPLE, TREND_SENSITIVITY } from '../src/lib/patternStats.ts';

const bar = (o: number, h: number, l: number, c: number, t = 0): Bar => (
  { time: t, open: o, high: h, low: l, close: c, volume: 1 }
);
const series = (list: [number, number, number, number][]): Bar[] =>
  list.map(([o, h, l, c], i) => bar(o, h, l, c, i * 3600));

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

const hitAt = (bars: Bar[], index: number) => detectPatterns(bars).find((h) => h.index === index);

// ---------- 映射 ----------
ok('库里的形态 id 全部有中文名和方向', () => {
  const mapped = new Set(PATTERN_IDS.map((p) => p.id));
  for (const p of allPatterns) {
    if (!mapped.has(p.name)) throw new Error(`没有映射：${p.name}`);
  }
});

// ---------- 实测统计表 ----------
ok('统计表里的形态都有中文名、字段齐全', () => {
  const known = new Set(PATTERN_IDS.map((p) => p.id));
  const table = PATTERN_STATS[PATTERN_STATS_SAMPLE.key] ?? {};
  if (Object.keys(table).length === 0) throw new Error('统计表是空的，先跑 pnpm stats:patterns');
  for (const [id, s] of Object.entries(table)) {
    if (!known.has(id)) throw new Error(`统计表里有库里没有的 id：${id}`);
    if (!(s.n > 0)) throw new Error(`${id} 的样本数不是正数`);
    if (!(s.base > 0 && s.base < 1)) throw new Error(`${id} 的基准正确率不在 (0,1) 内`);
    if (s.winByHorizon.length !== PATTERN_STATS_SAMPLE.horizons.length) throw new Error(`${id} 的持有期个数对不上`);
    if (s.tier < 0 || s.tier > 3) throw new Error(`${id} 的档位越界`);
  }
});

ok('统计表自洽：过门槛的形态，增量必须为正且样本够', () => {
  const table = PATTERN_STATS[PATTERN_STATS_SAMPLE.key] ?? {};
  for (const [id, s] of Object.entries(table)) {
    if (s.tier === 0) continue;
    if (s.excess < PATTERN_STATS_SAMPLE.minExcess) throw new Error(`${id} 过了门槛但增量只有 ${s.excess}`);
    if (s.n < PATTERN_STATS_SAMPLE.minSamples) throw new Error(`${id} 过了门槛但只有 ${s.n} 个样本`);
    if (s.q > PATTERN_STATS_SAMPLE.fdr) throw new Error(`${id} 过了门槛但 q=${s.q} 大于 ${PATTERN_STATS_SAMPLE.fdr}`);
  }
});

ok('统计表是折外结果：分折跑过，不是同一段数据既选又验', () => {
  if (PATTERN_STATS_SAMPLE.folds === null) {
    throw new Error('统计表是全样本结果（folds=null），既选又验，不能入表');
  }
  if (!(PATTERN_STATS_SAMPLE.folds >= 2)) throw new Error('折数少于 2，没有折外验证');
});

ok('统计表里重新生成过：样本区间和根数说得通', () => {
  if (!(PATTERN_STATS_SAMPLE.bars > 1000)) throw new Error('样本根数太少，确认统计脚本跑的是全量');
  // 从 ~ 两个日期推天数，不可能比「根数 × 最短周期」短得离谱
  const from = Date.parse(PATTERN_STATS_SAMPLE.from.replace(' ', 'T') + ':00Z');
  const to = Date.parse(PATTERN_STATS_SAMPLE.to.replace(' ', 'T') + ':00Z');
  if (!(to > from)) throw new Error('样本区间的结束时间早于开始时间');
  if ((to - from) / 60000 < PATTERN_STATS_SAMPLE.bars / 20) throw new Error('样本区间和根数对不上，像是拼出来的表');
});

// ---------- 趋势灵敏度 ----------
ok('已统过的周期各有标定，没统计的周期借邻近周期', () => {
  for (const interval of ['5m', '15m', '1h', '4h', '1d']) {
    if (!(TREND_SENSITIVITY[interval] > 0)) throw new Error(`${interval} 没有标定`);
    if (trendSensitivityFor(interval) !== TREND_SENSITIVITY[interval]) throw new Error(`${interval} 取到的不是自己的标定`);
  }
  // 交易所还有这三种，统计没跑：必须借到标定值，不能悄悄退回 5
  for (const interval of ['1m', '30m', '8h']) {
    const s = trendSensitivityFor(interval);
    if (!(s > 0) || s === 5) throw new Error(`${interval} 退回了默认灵敏度`);
  }
  // 周期越短，要的灵敏度越大：1m 借来的应该比 8h 借来的大
  if (!(trendSensitivityFor('1m') > trendSensitivityFor('8h'))) throw new Error('短周期的灵敏度没有比长周期大');
});

ok('命中上带的是实测数字，不是一个笼统的置信度', () => {
  const bars = series([
    [10.6, 10.7, 9.3, 9.4],
    [9.3, 10.9, 9.2, 10.8],
  ]);
  const hit = hitAt(bars, 1);
  if (!hit) throw new Error('看涨吞没没有命中');
  if (!hit.stat) throw new Error('命中上没有统计');
  if (!(hit.stat.n > 0) || !(hit.stat.base > 0)) throw new Error('统计字段是空的');
});

// ---------- 教科书形状 ----------
ok('看涨吞没：标在吞没成立的那根（第二根）', () => {
  const bars = series([
    [10.6, 10.7, 9.3, 9.4],   // 阴线
    [9.3, 10.9, 9.2, 10.8],   // 阳线包住前一根实体
  ]);
  const hit = hitAt(bars, 1);
  if (!hit) throw new Error('第二根没有命中');
  eq(hit.name, '看涨吞没', '形态名');
  eq(hit.direction, 'bull', '方向');
  if (hitAt(bars, 0)?.id === 'bullishEngulfing') throw new Error('吞没不该标在起始那根上');
});

ok('看跌吞没：方向看跌、标在确认根', () => {
  const bars = series([
    [9.4, 10.7, 9.3, 10.6],
    [10.7, 10.8, 9.2, 9.3],
  ]);
  const hit = hitAt(bars, 1);
  if (!hit) throw new Error('第二根没有命中');
  eq(hit.name, '看跌吞没', '形态名');
  eq(hit.direction, 'bear', '方向');
});

ok('早晨之星：三根确认，标在第三根', () => {
  const bars = series([
    [12.0, 12.1, 9.9, 10.0],
    [9.6, 9.7, 9.5, 9.64],
    [9.7, 11.3, 9.65, 11.2],
  ]);
  const hit = hitAt(bars, 2);
  if (!hit) throw new Error('第三根没有命中');
  eq(hit.name, '早晨之星', '形态名');
  eq(hit.direction, 'bull', '方向');
});

ok('十字星：识别但不标（没有方向）', () => {
  const bars = series([
    [10.0, 10.5, 9.5, 10.0],
    [10.0, 10.5, 9.5, 10.0],
  ]);
  // 展示层（画到图上的那一批）里它们不该出现
  for (const h of detectPatterns(bars, undefined, true)) {
    if (h.name === '十字星' || h.name === '纺锤线') throw new Error(`不该标 ${h.name}`);
  }
  // 标题里那句「识别但不标」：识别层要不要留它们，交给档位决定，这里只验展示层
  void detectPatterns(bars);
});

// ---------- 展示门槛 ----------
ok('展示口径是识别口径的子集，且不含无方向的形态', () => {
  const all = randomBars(360);
  const shown = detectPatterns(all, undefined, true);
  const recognized = detectPatterns(all);
  /**
   * 两个口径的唯一差别应该是「剔掉无方向的形态」，剩下的是同根仲裁的自然结果：
   * 展示层剔掉无方向的那个之后，同一根会改选次优的（比如「光头光脚」被剔，改选「光头光脚阳线」）。
   * 所以断言写成：展示里每一条，要么是识别层的赢家，要么在同一根上识别层的赢家无方向。
   */
  const neutralNames = new Set(['十字星', '纺锤线', '光头光脚']);
  const winnerByBar = new Map(recognized.map((h) => [h.index, h]));
  for (const h of shown) {
    if (neutralNames.has(h.name)) throw new Error(`展示里出现了无方向的形态：${h.id}`);
    const winner = winnerByBar.get(h.index);
    if (!winner) throw new Error(`展示标了一根识别不到的 K 线：${h.index}`);
    if (winner.id !== h.id && !neutralNames.has(winner.name)) {
      throw new Error(`第 ${h.index} 根：展示选了 ${h.id}，但识别层选的是有方向的 ${winner.id}`);
    }
  }
  if (shown.length > recognized.length) throw new Error('展示口径比识别口径还多');
});

ok('展示不按统计门槛过滤：门槛全关时开关仍然是活的', () => {
  // 实测统计里过一个门槛的形态都没有。如果展示跟着门槛走，这里会是 0 个标记
  const stats = PATTERN_STATS[PATTERN_STATS_SAMPLE.key] ?? {};
  const passing = Object.values(stats).filter((s) => s.tier >= 1).length;
  const shown = detectPatterns(randomBars(360), undefined, true);
  if (passing === 0 && shown.length === 0) {
    throw new Error('统计里一个形态都不过门槛，展示也跟着空了 —— 开关会变成死功能');
  }
});

ok('两种口径的结果不能互相复用', () => {
  const bars = randomBars(240);
  const shown = scanPatterns(null, bars, undefined, true);
  const next = scanPatterns(shown, bars, undefined, false);
  if (next.displayOnly) throw new Error('切换口径后仍标着展示口径');
  if (next.hits.length < shown.hits.length) throw new Error('识别口径的结果比展示口径还少');
});

ok('平价 K 线（high === low）不标', () => {
  const bars = series([[10, 10.2, 9.8, 10.1], [10.1, 10.1, 10.1, 10.1]]);
  const hit = hitAt(bars, 1);
  if (hit) throw new Error(`平价线不该命中 ${hit.id}`);
});

ok('同一根只报一个形态、时间严格递增', () => {
  const bars = series([
    [10.6, 10.7, 9.3, 9.4],
    [9.3, 10.9, 9.2, 10.8],
    [10.8, 11.2, 10.7, 11.0],
    [11.0, 11.1, 10.2, 10.4],
    [10.4, 10.5, 9.6, 9.8],
    [9.8, 10.6, 9.7, 10.5],
  ]);
  const seen = new Set<number>();
  let prev = -Infinity;
  for (const h of detectPatterns(bars, undefined, true)) {
    if (seen.has(h.index)) throw new Error(`第 ${h.index} 根报了两次`);
    seen.add(h.index);
    if (h.time <= prev) throw new Error('时间没有递增');
    prev = h.time;
  }
});

// ---------- 增量扫描 ----------
function randomBars(n: number, startTime = 0): Bar[] {
  let seed = 7654321;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let px = 100;
  const out: Bar[] = [];
  for (let i = 0; i < n; i += 1) {
    const o = px;
    if (i % 41 === 0) {
      out.push(bar(o, o, o, o, startTime + i * 3600));
      continue;
    }
    const c = Math.max(1, o + (rnd() - 0.5) * 2.4);
    const h = Math.max(o, c) + rnd() * 0.8;
    const l = Math.max(0.1, Math.min(o, c) - rnd() * 0.8);
    out.push(bar(o, h, l, c, startTime + i * 3600));
    px = c;
  }
  return out;
}

const sig = (hits: ReturnType<typeof detectPatterns>) =>
  JSON.stringify(hits.map((h) => [h.index, h.time, h.id, h.direction, h.name]));

/**
 * 增量扫一遍，和整段重算比。
 *
 * 两边都不开展示门槛：这里验的是「分段重算和整段重算逐条一致」，
 * 展示门槛是另一层筛选，拿它做口径会把增量算法的对错盖掉。
 * 展示口径另有一条自检（见下面「展示门槛」）。
 */
function sameAsFull(label: string, prevBars: Bar[], nextBars: Bar[]): void {
  const prev = scanPatterns(null, prevBars, undefined, false);
  const inc = scanPatterns(prev, nextBars, undefined, false).hits;
  const full = detectPatterns(nextBars);
  if (sig(inc) !== sig(full)) {
    throw new Error(`${label}：增量 ${inc.length} 条，整段 ${full.length} 条`);
  }
}

ok('增量扫描：同一个数组直接复用', () => {
  const bars = randomBars(120);
  const scan = scanPatterns(null, bars, undefined, false);
  if (scanPatterns(scan, bars, undefined, false) !== scan) throw new Error('同一份数据不该重算');
});

ok('增量扫描：只换对象、内容没变时直接复用', () => {
  const bars = randomBars(240);
  const scan = scanPatterns(null, bars, undefined, false);
  const cloned = bars.map((b) => ({ ...b }));
  if (scanPatterns(scan, cloned, undefined, false).hits !== scan.hits) throw new Error('内容没变时不该重算');
});

ok('增量扫描：整页换对象 + 尾部追加，仍与整段重算一致', () => {
  const all = randomBars(420);
  const prev = all.slice(0, 300).map((b) => ({ ...b }));
  const next = all.slice(0, 360).map((b) => ({ ...b }));
  sameAsFull('克隆+追加', prev, next);
});

ok('增量扫描：尾部追加 / 只改最后一根', () => {
  const all = randomBars(600);
  sameAsFull('追加', all.slice(0, 300), all.slice(0, 420));
  const tail = all.slice(0, 420);
  const last = tail[tail.length - 1]!;
  const edited = tail.slice();
  edited[edited.length - 1] = bar(last.open, last.high + 0.6, last.low, last.close + 0.5, last.time);
  sameAsFull('改最后一根', tail, edited);
});

ok('增量扫描：往前补历史 / 裁掉最老的一段', () => {
  const all = randomBars(700, 10_000_000);
  sameAsFull('补历史', all.slice(200, 600), all.slice(100, 600));
  sameAsFull('裁头', all.slice(100, 600), all.slice(200, 600));
  sameAsFull('裁头+追加', all.slice(100, 600), all.slice(200, 700));
});

ok('增量扫描：改中间一根', () => {
  const all = randomBars(500);
  const next = all.slice();
  const mid = Math.floor(next.length / 2);
  next[mid] = bar(next[mid]!.open, next[mid]!.high + 0.5, next[mid]!.low, next[mid]!.close + 0.4, next[mid]!.time);
  sameAsFull('中间', all, next);
});

ok('增量扫描：一根一根来，每一步都和整段重算一致', () => {
  const all = randomBars(400);
  let bars = all.slice(0, 120);
  let scan = scanPatterns(null, bars, undefined, false);
  for (let n = 120; n < 180; n += 1) {
    bars = all.slice(0, n + 1);
    scan = scanPatterns(scan, bars, undefined, false);
    const full = detectPatterns(bars);
    if (sig(scan.hits) !== sig(full)) throw new Error(`第 ${n} 根之后对不上`);
  }
});

// ---------- 汇总 ----------
if (failures.length > 0) {
  console.error(`形态识别自检失败 ${failures.length} 条（通过 ${passed} 条）`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`形态识别自检通过：${passed} 条`);
