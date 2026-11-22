/**
 * 形态识别自检。
 *
 * 用法： pnpm check:patterns
 *
 * 判定规则来自 vendor 进来的 cm45t3r/candlestick（MIT）。这里验四件事：
 *   1. 每个形态都映射到了中文名和方向，没有漏网的 id；
 *   2. 几组教科书形状能命中，而且标在「确认那根」上（两/三根形态的起始根不算）；
 *   3. 十字星/纺锤这类没有方向的、平价 K 线不上图；
 *   4. 增量扫描（补历史 / 来新 K 线 / 裁头 / 改中间）和整段重算结果完全一致。
 *
 * 第 4 条是这页最容易被改坏的地方：库的形态是「按起始根」返回的，两/三根形态
 * 要 +span-1 才是确认根，少算一格，图上就会整体早一根。
 */
import type { Bar } from '../src/lib/api.ts';
import { detectPatterns, scanPatterns, PATTERN_IDS } from '../src/lib/patterns.ts';
import { allPatterns } from '../src/lib/candlestick/patternChain.js';

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
  for (const h of detectPatterns(bars)) {
    if (h.name === '十字星' || h.name === '纺锤线') throw new Error(`不该标 ${h.name}`);
  }
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
  for (const h of detectPatterns(bars)) {
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

/** 增量扫一遍，和整段重算比 */
function sameAsFull(label: string, prevBars: Bar[], nextBars: Bar[]): void {
  const prev = scanPatterns(null, prevBars);
  const inc = scanPatterns(prev, nextBars).hits;
  const full = detectPatterns(nextBars);
  if (sig(inc) !== sig(full)) {
    throw new Error(`${label}：增量 ${inc.length} 条，整段 ${full.length} 条`);
  }
}

ok('增量扫描：同一个数组直接复用', () => {
  const bars = randomBars(120);
  const scan = scanPatterns(null, bars);
  if (scanPatterns(scan, bars) !== scan) throw new Error('同一份数据不该重算');
});

ok('增量扫描：只换对象、内容没变时直接复用', () => {
  const bars = randomBars(240);
  const scan = scanPatterns(null, bars);
  const cloned = bars.map((b) => ({ ...b }));
  if (scanPatterns(scan, cloned).hits !== scan.hits) throw new Error('内容没变时不该重算');
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
  let scan = scanPatterns(null, bars);
  for (let n = 120; n < 180; n += 1) {
    bars = all.slice(0, n + 1);
    scan = scanPatterns(scan, bars);
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
