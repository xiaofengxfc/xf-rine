
/**
 * 形态条件实验自检。
 *
 * 不碰网络、不读仓库数据，只验算法本身：
 *   1. 三重障碍：先到止盈 / 先到止损 / 同根双杀 / 超时；
 *   2. 成交模拟：下一根开盘、2 ATR 止损、成本折算；
 *   3. 条件匹配：命中必须找到同 state/方向/波动档的基准，找不到就不计数；
 *   4. 分块 z：已知正例要能认出来（泄漏对照），不能把正例算成零；
 *   5. 条件因果：只喂到第 i 根，和第 i 根之前的数据算出的 state 必须一致；
 *   6. 关键位代理、引擎时间线、资金费、订单流四个 state 的边界。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  barrierAt, aggregate, clusterZ, tradeAt, type Bar, type BaseAgg, type Hit, type StateCtx,
} from './pattern-context-core.ts';
import { levelProxyState, loadEngineTimelines, engineState, fundingState, flowState, oiState } from './pattern-context-features.ts';

const bar = (o: number, h: number, l: number, c: number, t = 0): Bar => ({ time: t, open: o, high: h, low: l, close: c, volume: 1 });
const ctxOf = (bars: Bar[], i: number, atr: number[], sym = 'BTC_USDT', iv = '4h'): StateCtx => ({
  bars, i, atr, atrPct: atr.map(() => 0.01), volT: atr.map(() => 0), sym, iv,
});

let passed = 0;
const failures: string[] = [];
function ok(name: string, fn: () => void): void {
  try { fn(); passed += 1; } catch (err) { failures.push(name + ': ' + (err as Error).message); }
}
function eq(a: unknown, b: unknown, what: string): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(what + ' 期望 ' + sb + '，实际 ' + sa);
}
function close(a: number, b: number, what: string, eps = 1e-9): void {
  if (!Number.isFinite(a) || Math.abs(a - b) > eps) throw new Error(what + ' 期望 ' + b + '，实际 ' + a);
}

// ---------- 三重障碍 ----------
ok('三重障碍：先到止盈算赢', () => {
  const bars = [bar(100, 100, 100, 100), bar(100, 102, 99.5, 101)];
  const o = barrierAt(bars, [1, 1], 0, 1, 1, 1)!;
  eq(o.win, 1, 'win'); eq(o.pnl, 1, 'pnl'); eq(o.timeout, 0, 'timeout');
});
ok('三重障碍：先到止损算亏', () => {
  const bars = [bar(100, 100, 100, 100), bar(100, 100.5, 98, 99)];
  const o = barrierAt(bars, [1, 1], 0, 1, 1, 1)!;
  eq(o.win, 0, 'win'); eq(o.pnl, -1, 'pnl');
});
ok('三重障碍：同一根两边都碰到按最坏算', () => {
  const bars = [bar(100, 100, 100, 100), bar(100, 102, 98, 100)];
  const o = barrierAt(bars, [1, 1], 0, 1, 1, 1)!;
  eq(o.win, 0, 'win'); eq(o.pnl, -1, 'pnl');
});
ok('三重障碍：都没碰到按超时收盘价算', () => {
  const bars = [bar(100, 100, 100, 100), bar(100, 100.4, 99.6, 100.2)];
  const o = barrierAt(bars, [1, 1], 0, 1, 1, 1)!;
  eq(o.timeout, 1, 'timeout'); close(o.pnl, 0.2, 'pnl');
});

// ---------- 成交模拟 ----------
ok('成交模拟：下一根开盘入场、2 ATR 止损、持 20 根', () => {
  const bars: Bar[] = [];
  for (let i = 0; i < 40; i += 1) bars.push(bar(100, 100.5, 99.5, 100, i * 3600));
  bars[1] = bar(101, 101.5, 100.5, 101, 3600);
  const r = tradeAt(bars, bars.map(() => 1), 0, 1, 20, 2)!;
  eq(r.exit, 21, 'exit');
  close(r.pnl, -1.1414, 'pnl', 1e-6);
});
ok('成交模拟：跌到 2 ATR 止损', () => {
  const bars: Bar[] = [];
  for (let i = 0; i < 40; i += 1) bars.push(bar(100, 100.5, 99.5, 100, i * 3600));
  bars[1] = bar(100, 100.5, 99.5, 100, 3600);
  bars[2] = bar(100, 100.2, 97, 97.5, 7200);
  const r = tradeAt(bars, bars.map(() => 1), 0, 1, 20, 2)!;
  eq(r.exit, 2, 'exit');
  close(r.pnl, -2.14, 'pnl', 1e-6);
});

// ---------- 条件匹配 ----------
function baseCell(): BaseAgg {
  return {
    n: 10, n3: 10, w3: 6, ret3s: 0, ret3n: 10, ret20: 0, n20: 10,
    bar: new Map([['2:1', { n: 10, nw: 10, w: 5, pnl: 0 }]]),
  };
}
function hitOf(state: string, ret3: number): Hit {
  return {
    id: 'hammer', dir: 1, iv: '4h', sym: 'BTC_USDT', fold: 0, idx: 10, volT: 0, atrPct: 0.01,
    state, align: 1, ret3, ret20: 1,
    bar: { '2:1': { pnl: 2, win: 1, timeout: 0 } },
  };
}
ok('条件匹配：命中找到同 state/方向/波动档的基准', () => {
  const base = new Map<string, BaseAgg>([['4h|0|1|S', baseCell()]]);
  const a = aggregate([hitOf('S', 0.5)], base);
  eq(a.n, 1, 'n'); eq(a.matched, 1, 'matched');
  eq(a.w3, 1, 'w3'); close(a.baseW3, 0.6, 'baseW3');
  const cell = a.bar.get('2:1')!;
  close(cell.net, 2 - 0.14, 'net');
  close(cell.baseNet, -0.14, 'baseNet');
});
ok('条件匹配：找不到基准就不进统计', () => {
  const base = new Map<string, BaseAgg>([['4h|0|1|S', baseCell()]]);
  const a = aggregate([hitOf('R', 0.5)], base);
  eq(a.n, 1, 'n'); eq(a.matched, 0, 'matched'); eq(a.n3, 0, 'n3');
});
ok('已知正例要能认出来（泄漏对照）', () => {
  const hits: Hit[] = [];
  for (let i = 0; i < 100; i += 1) hits.push(hitOf(i % 2 === 0 ? 'good' : 'bad', i % 2 === 0 ? 1 : -1));
  const base = new Map<string, BaseAgg>([
    ['4h|0|1|good', baseCell()],
    ['4h|0|1|bad', baseCell()],
  ]);
  const a = aggregate(hits.filter((h) => h.state === 'good'), base);
  eq(a.w3, 50, 'w3'); close(a.baseW3, 0.6 * 50, 'baseW3');
  close(a.w3 / a.n3 - a.baseW3 / a.matched, 0.4, 'excess');
});

ok('分块 z：分块后仍认得出正例', () => {
  const blocks = new Map([
    ['a', { w: 40, b: 25, n: 50, r20: 0, b20: 0, n20: 0 }],
    ['b', { w: 35, b: 25, n: 50, r20: 0, b20: 0, n20: 0 }],
  ]);
  const z = clusterZ({
    n: 100, matched: 100, n3: 100, w3: 75, baseW3: 50, ret3: 0, ret20: 0, n20: 0,
    baseRet3: 0, baseRet3n: 0, baseRet20: 0, baseRet20n: 0, ret20s: [],
    bar: new Map(), blocks,
  } as any);
  if (!(z > 0)) throw new Error('z 应为正，实际 ' + z);
});

// ---------- 条件因果 ----------
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
ok('关键位代理：只喂到第 i 根，state 不变', () => {
  const rnd = lcg(7);
  const bars: Bar[] = [];
  let c = 100;
  for (let i = 0; i < 200; i += 1) {
    c += (rnd() - 0.5) * 2;
    bars.push(bar(c, c + 1, c - 1, c, i * 3600));
  }
  const atr = bars.map(() => 1);
  const state = levelProxyState(20, 0.5);
  for (let i = 60; i < 180; i += 1) {
    const full = state(ctxOf(bars, i, atr));
    const trunc = state(ctxOf(bars.slice(0, i + 1), i, atr.slice(0, i + 1)));
    if (full !== trunc) throw new Error('第 ' + i + ' 根不一致：' + full + ' vs ' + trunc);
  }
});
ok('关键位代理：贴低点是 S，贴高点是 R', () => {
  const bars: Bar[] = [];
  for (let i = 0; i < 20; i += 1) bars.push(bar(100, 110, 90, 100, i * 3600));
  const atr = bars.map(() => 1);
  bars.push(bar(90, 91, 89.8, 90.2, 20 * 3600));
  atr.push(1);
  eq(levelProxyState(20, 0.5)(ctxOf(bars, 20, atr)), 'S', 'S');
  bars[20] = bar(110, 110.2, 109, 109.8, 20 * 3600);
  eq(levelProxyState(20, 0.5)(ctxOf(bars, 20, atr)), 'R', 'R');
});

// ---------- 引擎时间线 ----------
ok('引擎关键位：时间线最近的支撑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xf-pc-'));
  try {
    writeFileSync(join(dir, 'BTC_USDT_4h.json'), JSON.stringify({
      slices: [{ from: 0, to: 2, zones: [{ center: 99.6, low: 99.4, high: 99.8, type: 'support', edge: 1 }] }],
    }));
    const tl = loadEngineTimelines(dir, ['BTC_USDT'], ['4h']);
    const bars = [bar(100, 100.5, 99.5, 100, 0), bar(100, 100.5, 99.5, 100, 1), bar(100, 100.5, 99.5, 100, 2)];
    eq(engineState(tl, 0.5)(ctxOf(bars, 2, bars.map(() => 1))), 'S', 'S');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 资金费 ----------
ok('资金费：最后一笔在 90 天最高档是 F_high', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xf-pc-'));
  try {
    const rows = [];
    for (let j = 0; j < 300; j += 1) rows.push({ t: j * 28800, r: j / 1e6 });
    writeFileSync(join(dir, 'BTC_USDT_funding.json'), JSON.stringify(rows));
    const bars = [bar(100, 100, 100, 100, 299 * 28800)];
    const f = fundingState(dir, ['BTC_USDT']);
    eq(f.stateOf(ctxOf(bars, 0, [1])), 'F_high', 'F_high');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 订单流 ----------
ok('订单流：最后一根 taker buy 占比在 50 根最高档是 T_high', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xf-pc-'));
  try {
    const rows = [];
    for (let j = 0; j < 60; j += 1) rows.push({ time: j * 14400, volume: 100, takerBuy: 40 + j });
    writeFileSync(join(dir, 'BTC_USDT_4h.json'), JSON.stringify(rows));
    const bars = [bar(100, 100, 100, 100, 59 * 14400)];
    const f = flowState(dir, ['BTC_USDT'], ['4h']);
    eq(f.stateOf(ctxOf(bars, 0, [1])), 'T_high', 'T_high');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 持仓 / 清算 ----------
ok('清算失衡：多头被大量清算时是 L_long', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xf-pc-'));
  try {
    const rows = [];
    for (let j = 0; j < 40; j += 1) {
      rows.push({ t: j * 14400, open_interest: 1000 * Math.pow(1.01, j), long_liq_size: 900, short_liq_size: 100 });
    }
    writeFileSync(join(dir, 'BTC_USDT_stats_4h.json'), JSON.stringify(rows));
    const bars = [bar(100, 100, 100, 100, 39 * 14400)];
    const f = oiState(dir, ['BTC_USDT'], ['4h'], 'liq');
    eq(f.stateOf(ctxOf(bars, 0, [1])), 'L_long', 'L_long');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
ok('OI：持续放大且落在 90 根最高档是 OI_up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xf-pc-'));
  try {
    const rows = [];
    for (let j = 0; j < 200; j += 1) {
      rows.push({ t: j * 14400, open_interest: 1000 * Math.pow(1.01, j), long_liq_size: 10, short_liq_size: 10 });
    }
    writeFileSync(join(dir, 'BTC_USDT_stats_4h.json'), JSON.stringify(rows));
    const bars = [bar(100, 100, 100, 100, 199 * 14400)];
    const f = oiState(dir, ['BTC_USDT'], ['4h'], 'oi');
    eq(f.stateOf(ctxOf(bars, 0, [1])), 'OI_up', 'OI_up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 汇总 ----------
if (failures.length > 0) {
  console.error('形态条件自检失败 ' + failures.length + ' 条（通过 ' + passed + ' 条）');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('形态条件自检通过：' + passed + ' 条');
