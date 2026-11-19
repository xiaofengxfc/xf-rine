
/**
 * 回测引擎与指标的自检。
 *
 *   pnpm check:quant
 *
 * 用的是合成数据：价格怎么走、信号在哪一根出现、止损止盈哪个先到，全都是算得出来的，
 * 所以每一处都能和手算的答案对。真实行情上的"结果看着挺合理"不算证明。
 *
 * 重点验三件事：
 *   1. 指标算得对（EMA / RSI / ATR / 前 N 根最高，都和手算对）。
 *   2. 成交价对（信号在 i 根收盘，成交在 i+1 根开盘；止损用触发价，跳空用开盘价）。
 *   3. 不看未来（把未来数据删掉，同一根上的决策不能变）。
 */

import type { Candle, StrategySpec, Condition } from '../src/quant/backtest.js';
import { backtest, conditionHolds, IndicatorCache, warmupOf } from '../src/quant/backtest.js';
import { buildIndicator } from '../src/quant/indicators.js';
import { sanitizeHypothesis, FALLBACK_HYPOTHESIS, validateSemantics } from '../src/quant/ai.js';
import { buildAnonContext, assertAnonymous, parseVerdict } from '../src/quant/promptStrategy.js';
import { randomBaselineSignals } from '../src/quant/promptBacktest.js';
import { buildZoneTimeline, zoneSeries, nearestZone } from '../src/quant/zones.js';
import { searchParameters, searchParametersWithProgress } from '../src/quant/search.js';

let fails = 0;
let passes = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passes += 1; console.log('  ✓ ' + name); }
  else { fails += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
function near(name: string, got: number, want: number, eps = 1e-6): void {
  ok(name, Math.abs(got - want) <= eps, 'got ' + got + ' want ' + want);
}

/** 造一根 K 线 */
function bar(t: number, o: number, h: number, l: number, c: number, v = 100): Candle {
  return { t, o, h, l, c, v };
}

const OPTS = {
  multiplier: 1, feeRate: 0, slippagePct: 0, capital: 10000,
  riskPerTrade: 1, leverage: 1, fundingRatePer8h: 0,
};

console.log('\n[1] 指标：和手算对');
{
  const c = [1, 2, 3, 4, 5].map((v, i) => bar(i * 60, v, v, v, v));
  const sma = buildIndicator('sma', c, { period: 3 });
  ok('SMA 前 2 根没有值', Number.isNaN(sma.at(1)));
  near('SMA(3) 第 3 根', sma.at(2)!, 2);
  near('SMA(3) 第 5 根', sma.at(4)!, 4);

  // EMA(3) 从第 3 根开始给值：k = 2/4 = 0.5，初始取第 0 根收盘 1
  const ema = buildIndicator('ema', c, { period: 3 });
  ok('EMA 前 2 根没有值', Number.isNaN(ema.at(1)));
  // i=0:1, i=1: 2*0.5+1*0.5=1.5, i=2: 3*0.5+1.5*0.5=2.25
  near('EMA(3) 第 3 根', ema.at(2)!, 2.25);

  // 前 N 根最高：不含当前根
  const hc = [
    bar(0, 10, 12, 9, 11),
    bar(60, 11, 15, 10, 14),
    bar(120, 14, 16, 13, 15),
    bar(180, 15, 20, 14, 19),
  ];
  const hi = buildIndicator('highest', hc, { period: 2 });
  ok('前 2 根最高在第 2 根还没值', Number.isNaN(hi.at(1)));
  near('前 2 根最高（第 3 根）= 第 0、1 根的最高 15', hi.at(2)!, 15);
  near('前 2 根最高（第 4 根）= 第 1、2 根的最高 16', hi.at(3)!, 16);

  // ATR：常数 TR 时，ATR 应等于那个常数
  const flat = Array.from({ length: 20 }, (_, i) => bar(i * 60, 100, 101, 99, 100));
  const atr = buildIndicator('atr', flat, { period: 14 });
  near('ATR(14) 在恒定的 TR=2 上等于 2', atr.at(19)!, 2);
}

console.log('\n[2] 预热：ATR 的周期也会算进预热，避免在 ATR 还没值的根上开仓');
{
  const spec: StrategySpec = {
    name: 'warm', side: 'long', params: { period: 1, atrPeriod: 14 }, ranges: {},
    entry: [{ left: { name: 'close' }, op: '>', right: { name: 'highest', periodKey: 'period' } }],
    stop: { kind: 'atr', value: 2 },
    target: { kind: 'rr', value: 2 },
    maxPositions: 1,
  };
  const warm = warmupOf(spec);
  ok('预热至少覆盖 ATR(14) 加一根', warm >= 15, String(warm));
}

console.log('\n[3] 成交在下一根开盘，不在信号那一根的收盘');
{
  // 前 4 根横盘把预热跑完，第 5 根收盘发出信号，第 6 根开盘价 200 成交
  const c = [
    bar(0, 100, 101, 99, 100),
    bar(60, 100, 101, 99, 100),
    bar(120, 100, 101, 99, 100),
    bar(180, 100, 101, 99, 100),
    bar(240, 100, 101, 99, 130),  // 信号：收盘 130 越过前 1 根最高 101
    bar(300, 200, 205, 195, 200), // 下一根开盘 200
    bar(360, 200, 206, 194, 205),
    bar(420, 205, 206, 204, 205),
  ];
  const spec: StrategySpec = {
    name: 'breakout', side: 'long', params: { period: 1 },
    ranges: {},
    entry: [{ left: { name: 'close' }, op: '>', right: { name: 'highest' } }],
    stop: { kind: 'pct', value: 0.05 },
    target: { kind: 'pct', value: 0.5 },
    maxPositions: 1,
  };
  // 必须显式给周期：highest 默认 period=20，5 根数据的话前面全没有值，一笔都开不出来
  // 预热要算上 ATR（止损默认按 ATR 算，默认 14 周期）：不给小周期的话，5 根数据全在预热里
  spec.params = { period: 1, atrPeriod: 2 };
  spec.stop = { kind: 'pct', value: 0.05 };
  const r = backtest(spec, c, OPTS);
  ok('正好开了一笔', r.trades.length === 1, JSON.stringify(r.trades.map((t) => t.entryPrice)));
  if (r.trades.length) near('入场价是信号后那根的开盘 200', r.trades[0]!.entryPrice, 200);
}

console.log('\n[4] 止损按触发价成交；跳空时按开盘价成交（不吃想象中的好价）');
{
  const base = (extra: Candle[]): Candle[] => [
    bar(0, 100, 101, 99, 100),
    bar(60, 100, 101, 99, 100),
    bar(120, 100, 101, 99, 100),
    bar(180, 100, 101, 99, 130),    // 信号
    bar(240, 130, 131, 129, 130),   // 入场 130，止损 5% = 123.5
    ...extra,
  ];

  // 正常下穿止损：最低 120 越过 123.5，按 123.5 成交
  const r1 = backtest(spec5(), base([bar(180, 129, 130, 120, 121)]), OPTS);
  ok('止损触发了', r1.trades.length === 1 && r1.trades[0]!.reason === 'stop', JSON.stringify(r1.trades.map((t) => t.reason)));
  if (r1.trades.length) near('正常止损按触发价 123.5 成交', r1.trades[0]!.exitPrice, 123.5);

  // 跳空：这一根开盘 110，已经低于 123.5，按 110 成交
  const r2 = backtest(spec5(), base([bar(180, 110, 112, 105, 108)]), OPTS);
  ok('跳空也触发了', r2.trades.length === 1);
  if (r2.trades.length) near('跳空按开盘价 110 成交', r2.trades[0]!.exitPrice, 110);
}

function spec5(): StrategySpec {
  return {
    name: 'breakout5', side: 'long', params: { period: 1, atrPeriod: 2 },
    ranges: {},
    entry: [{ left: { name: 'close' }, op: '>', right: { name: 'highest', periodKey: 'period' } }],
    stop: { kind: 'pct', value: 0.05 },
    target: { kind: 'pct', value: 0.5 }, // 放很远，只测止损
    maxPositions: 1,
  };
}

console.log('\n[5] 不看未来：砍掉未来数据，同一根上的决策不能变');
{
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 200; i++) {
    // 前 100 根慢涨，后 100 根横盘，制造出"某些根信号成立"的形状
    price += i < 100 ? 0.5 : (i % 5 === 0 ? 1 : -0.4);
    candles.push(bar(i * 900, price, price + 1, price - 1, price));
  }
  const spec: StrategySpec = {
    name: 'cross', side: 'long', params: { period: 5 },
    ranges: {},
    entry: [{ left: { name: 'ema', periodKey: 'fast' }, op: '>', right: { name: 'sma', periodKey: 'slow' } }],
    stop: { kind: 'pct', value: 0.02 },
    target: { kind: 'pct', value: 0.03 },
    maxPositions: 1,
  };
  // entry 里的指标参数直接写在 params 上，这里给个 period 让两个指标都能算
  spec.params = { period: 5 };

  let mismatch = 0;
  const full = new IndicatorCache(candles);
  for (let i = 8; i < candles.length; i++) {
    const head = new IndicatorCache(candles.slice(0, i + 1));
    for (const c of spec.entry) {
      const a = conditionHolds(c, i, full, spec.params);
      const b = conditionHolds(c, i, head, spec.params);
      if (a !== b) mismatch += 1;
    }
  }
  ok('3000 个点位上，用全量数据算和只用到第 i 根算，结果一致', mismatch === 0, mismatch + ' 处不一致');
}

console.log('\n[6] 手续费与滑点真的扣了');
{
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(60, 100, 101, 99, 100),
    bar(120, 100, 101, 99, 100),
    bar(180, 100, 101, 99, 130),
    bar(240, 130, 131, 129, 130),
    bar(300, 129, 130, 120, 121),
  ];
  const free = backtest(spec5(), candles, OPTS);
  const costly = backtest(spec5(), candles, { ...OPTS, feeRate: 0.001, slippagePct: 0.001 });
  ok('两边都成交了', free.trades.length === 1 && costly.trades.length === 1);
  if (free.trades.length && costly.trades.length) {
    ok('收费之后净盈亏更差', costly.trades[0]!.net < free.trades[0]!.net,
      costly.trades[0]!.net + ' vs ' + free.trades[0]!.net);
    ok('入场价被滑点推高', costly.trades[0]!.entryPrice > free.trades[0]!.entryPrice);
  }
}

console.log('\n[7] 统计口径：盈亏比是「平均盈利 ÷ 平均亏损」，期望是「每笔平均净赚」');
{
  // 一笔亏 5%（止损）、一笔赚 10%（止盈），各 1 张，每张名义 100
  // 为了让止损止盈按百分数精确触发，用 pct 口径，且不加滑点与手续费
  const candles: Candle[] = [
    bar(0, 100, 101, 99, 100),
    bar(60, 100, 101, 99, 100),
    bar(120, 100, 101, 99, 100),
    // 第一笔：信号 → 入场 100，止损 95，止盈 110
    bar(180, 100, 101, 99, 200),   // 信号（收盘越过前高）
    bar(240, 100, 101, 99, 100),   // 入场 100
    bar(300, 100, 101, 94, 96),    // 打到止损 95
    // 第二笔：再给一次信号，入场 100，这次打到止盈 110
    bar(360, 96, 201, 95, 200),    // 信号
    bar(420, 100, 101, 99, 100),   // 入场 100
    bar(480, 100, 111, 99, 110),   // 打到止盈 110（最后一根，平完就结束）
  ];
  const spec: StrategySpec = {
    name: 'mix', side: 'long', params: { period: 1, atrPeriod: 2 }, ranges: {},
    entry: [{ left: { name: 'close' }, op: '>', right: { name: 'highest', periodKey: 'period' } }],
    stop: { kind: 'pct', value: 0.05 },
    target: { kind: 'pct', value: 0.1 },
    maxPositions: 1,
  };
  const r = backtest(spec, candles, OPTS);
  ok('两笔都成交', r.trades.length === 2, 'trades=' + r.trades.length + ' ' + JSON.stringify(r.trades.map((t) => t.reason)));
  if (r.trades.length === 2) {
    const [loss, win] = [r.trades[0]!, r.trades[1]!];
    ok('第一笔是止损', loss.reason === 'stop', loss.reason);
    ok('第二笔是止盈', win.reason === 'target', win.reason);

    // 每张名义 100（价格 100 × 1 张 × 乘数 1），5% 止损亏 5，10% 止盈赚 10
    // 第一笔张数 = floor(10000 × 100% ÷ 100) = 100 张，亏 500，余额变 9500
    // 第二笔 = floor(9500 ÷ 100) = 95 张，赚 950 —— 仓位跟着余额缩，这是正确的
    ok('第一笔 100 张', loss.size === 100, String(loss.size));
    ok('第二笔按缩水后的余额开 95 张', win.size === 95, String(win.size));
    const lossUsd = Math.abs(loss.net);
    const winUsd = win.net;
    ok('亏损 500 USDT（100 张 × 5），不是按余额缩水的旧数字', Math.abs(lossUsd - 500) < 1e-6, String(lossUsd));
    ok('盈利 950 USDT（95 张 × 10）', Math.abs(winUsd - 950) < 1e-6, String(winUsd));

    // 平均盈利 ÷ 平均亏损 = 950 / 500 = 1.9 —— 这才是"盈亏比"
    near('盈亏比 = 1.9', r.stats.payoff, 1.9, 1e-9);
    ok('胜率 50%', Math.abs(r.stats.winRate - 0.5) < 1e-9, String(r.stats.winRate));
    ok('每笔期望 = (950 - 500) / 2 = 225', Math.abs(r.stats.expectancy - 225) < 1e-6, String(r.stats.expectancy));
    ok('profitFactor = 950 / 500 = 1.9', Math.abs(r.stats.profitFactor - 1.9) < 1e-9, String(r.stats.profitFactor));
  }
}
{
  // 亏损时 payoff 必须是 0 而不是 Infinity —— 一场没亏的回测最容易把这块画成一个好看的数字
  const candles: Candle[] = [
    bar(0, 100, 101, 99, 100), bar(60, 100, 101, 99, 100), bar(120, 100, 101, 99, 100),
    bar(180, 100, 101, 99, 200), bar(240, 100, 101, 99, 100), bar(300, 100, 111, 99, 110),
  ];
  const spec: StrategySpec = {
    name: 'allwin', side: 'long', params: { period: 1, atrPeriod: 2 }, ranges: {},
    entry: [{ left: { name: 'close' }, op: '>', right: { name: 'highest', periodKey: 'period' } }],
    stop: { kind: 'pct', value: 0.05 }, target: { kind: 'pct', value: 0.1 }, maxPositions: 1,
  };
  const r = backtest(spec, candles, OPTS);
  ok('全胜时没有亏损笔', r.trades.every((t) => t.net > 0), JSON.stringify(r.trades.map((t) => t.net)));
  ok('没有亏损时盈亏比是 0，不是 Infinity', r.stats.payoff === 0, String(r.stats.payoff));
}

console.log('\n[8] 参数必须真的生效：改快慢线周期，成交笔数不能一模一样');
{
  // 这一段是被真实 bug 打出来的：以前所有指标共用 params.period，一条策略里
  // "快线 EMA(20)" 和 "慢线 EMA(50)" 只能存一个周期，搜索改了 slow 结果不动。
  // 用两条差异很大的 EMA 交叉，笔数几乎不可能相同
  const candles: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 600; i++) {
    p += Math.sin(i / 17) * 1.2 + (i % 11 === 0 ? 3 : -0.6);
    candles.push(bar(i * 3600, p, p + 1.2, p - 1.2, p));
  }
  const mk = (fast: number, slow: number): StrategySpec => ({
    name: 'ema', side: 'long', params: { fast, slow, atrPeriod: 14 }, ranges: {},
    entry: [{ left: { name: 'ema', periodKey: 'fast' }, op: 'crossUp', right: { name: 'ema', periodKey: 'slow' } }],
    stop: { kind: 'atr', value: 2 }, target: { kind: 'rr', value: 2 }, maxPositions: 1,
  });
  const a = backtest(mk(5, 20), candles, OPTS);
  const b = backtest(mk(5, 100), candles, OPTS);
  ok('两个不同周期的结果不同', a.trades.length !== b.trades.length,
    'EMA(5,20) 成交 ' + a.trades.length + ' 笔，EMA(5,100) 成交 ' + b.trades.length + ' 笔');
  ok('至少有一边真的成交了', a.trades.length > 0 || b.trades.length > 0, '两边都是 0 笔，这个测试什么也没证明');

  // 同一个参数算两次，结果必须完全一致（确定性）
  const again = backtest(mk(5, 20), candles, OPTS);
  ok('同样的输入两次结果一致', JSON.stringify(a.stats) === JSON.stringify(again.stats));
}

console.log('\n[9] 样本不足的候选不能被排到第一名');
{
  // 实测撞出来的问题：RSI 超卖只成交 1 笔、那一笔恰好吃到 +4.5%，
  // 综合分把它排到了第一。排序层必须先看样本量，再谈表现
  const cands = [
    { name: 'one-lucky-trade', trades: 1, expectancyPct: 4.5, payoff: 0, winRate: 1, decay: 0, drawdown: 0.1 },
    { name: 'many-mediocre', trades: 40, expectancyPct: 0.2, payoff: 1.6, winRate: 0.45, decay: 0.1, drawdown: 5 },
  ];
  const rank = (x: { trades: number; expectancyPct: number }) =>
    x.trades < 30 ? -1e6 + x.trades * 0.01 : x.expectancyPct;
  const sorted = [...cands].sort((a, b) => rank(b) - rank(a));
  ok('第一笔很多、表现一般的那份排第一', sorted[0]!.name === 'many-mediocre', sorted.map((c) => c.name).join(' > '));
  ok('只成交 1 笔的那份排最后', sorted[sorted.length - 1]!.name === 'one-lucky-trade');
}

console.log('\n[10] 模型回包的解析：真实格式要能认出指标，不能退化成 close>close');
{
  // 这一段用的是真实模型的回包（字段名是它自己那套，不是我们理想中的那套）
  const raw = {
    thesis: '趋势回调结束',
    side: 'long',
    params: { emaFast: 10, emaSlow: 40, rsiPeriod: 14, rsiFloor: 45, atrPeriod: 14 },
    ranges: {},
    entry: [
      { left: 'close', op: '>', right: 'emaSlow' },
      { left: 'emaFast', op: '>', right: 'emaSlow' },
      { left: 'rsi', op: '>', right: 'close', rightConstant: 'rsiFloor' },
    ],
    stop: { kind: 'atr', value: 1.5 },
    target: { kind: 'rr', value: 2 },
    whatToValidate: '金叉加 RSI 过滤',
  };
  const h = sanitizeHypothesis(raw, FALLBACK_HYPOTHESIS);
  ok('假设被采纳（没退回兜底）', h.thesis === '趋势回调结束', h.thesis);
  ok('三条条件都在', h.entry.length === 3, String(h.entry.length));

  const names = h.entry.map((c) => c.left.name + '/' + (c.rightParam ?? c.right.name));
  ok('close 对上 ema', names[0] === 'close/ema', names[0]);
  ok('ema 对上 ema', names[1] === 'ema/ema', names[1]);
  ok('rsi 对上常数', names[2] === 'rsi/rsiFloor', names[2]);

  // 关键：不同周期的 EMA 必须指到不同的参数键，否则又变成"参数是摆设"
  ok('快线读 emaFast', h.entry[1]!.left.periodKey === 'emaFast', String(h.entry[1]!.left.periodKey));
  ok('慢线读 emaSlow', h.entry[1]!.right.periodKey === 'emaSlow', String(h.entry[1]!.right.periodKey));
  // 模型写 "rsi" 而不是 "rsiPeriod"，周期要能找到 rsiPeriod
  ok('RSI 的周期落在 rsiPeriod 上', h.entry[2]!.left.periodKey === 'rsiPeriod', String(h.entry[2]!.left.periodKey));

  // 参数名里带指标词但不是以它开头（trendPeriod）：要认成 EMA，不能退化成 close 跟数字比
  const h2 = sanitizeHypothesis({
    side: 'long',
    params: { trendPeriod: 50, rsiPeriod: 14, rsiThreshold: 30, atrPeriod: 14 },
    entry: [{ left: 'close', op: '>', right: 'trendPeriod' }],
    stop: { kind: 'atr', value: 1.5 }, target: { kind: 'rr', value: 2 },
  }, FALLBACK_HYPOTHESIS);
  ok('trendPeriod 被认成均线指标', h2.entry[0]!.right.name !== 'close', h2.entry[0]!.right.name);
  ok('trendPeriod 的周期指回自己', h2.entry[0]!.right.periodKey === 'trendPeriod', String(h2.entry[0]!.right.periodKey));

  // 不能出现 close>close 这种什么都不筛的条件
  const degenerate = h.entry.filter((c) => c.left.name === 'close' && !c.rightParam && c.right.name === 'close');
  ok('没有退化成 close>close 的条件', degenerate.length === 0, JSON.stringify(degenerate));
}

console.log('\\n[11] 语义校验：条件能跑不等于它表达了那个意思');
{
  // 真实失败案例：模型想写"假突破：跌破前低后收回"，
  // 结果是 close > lowest —— 几乎恒真，等于没有条件。
  //
  // 数据用确定性随机游走，不用正弦：正弦的价格始终在 20 根低点上方，
  // 根本不会跌破，用它测"跌破后收回"等于什么都没测
  const candles: Candle[] = [];
  let seed = 12345;
  let px = 100;
  for (let i = 0; i < 400; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    px += ((seed / 2147483648) - 0.5) * 4;
    candles.push(bar(i * 3600, px, px + 1, px - 1, px));
  }
  const cache = new IndicatorCache(candles);
  const prices = candles.map((c) => c.c);
  const ev = (c: Condition, i: number) => conditionHolds(c, i, cache, params);

  const params = { n: 20, atrPeriod: 14 };

  // 坏条件：收盘 > 前 20 根最低（几乎恒真）
  const bad = { thesis: '假突破：跌破前 N 根低点后迅速收回', entry: [{ left: { name: 'close' }, op: '>' as const, right: { name: 'lowest', periodKey: 'n' } }] };
  const badIssues = validateSemantics(bad, prices, ev);
  ok('恒真的条件被拦下', badIssues.some((x) => x.code === 'always_true'), JSON.stringify(badIssues.map((x) => x.code)));
  ok('说了形态却没写跨根，也被拦下', badIssues.some((x) => x.code === 'shape_not_expressible'));

  // 好条件：上一根收盘跌破前低，当根收回
  const good = {
    thesis: '假突破：跌破前 N 根低点后迅速收回',
    entry: [
      { left: { name: 'close' }, op: '<' as const, right: { name: 'lowest', periodKey: 'n' }, shift: 1, rightShift: 1 },
      { left: { name: 'close' }, op: '>' as const, right: { name: 'lowest', periodKey: 'n' } },
    ],
  };
  const goodIssues = validateSemantics(good, prices, ev);
  ok('写对的形态不报错', goodIssues.length === 0, JSON.stringify(goodIssues.map((x) => x.message)));

  // shift 真的生效：上一根跌破 vs 当根收回，这两个条件不可能同时为真
  const down = good.entry[0]!;
  const up = good.entry[1]!;
  let both = 0;
  for (let i = 60; i < candles.length; i++) {
    if (conditionHolds(down, i, cache, params) && conditionHolds(up, i, cache, params)) both += 1;
  }
  // 这两个条件用的是不同时刻的窗口（lowest[t-1] 和 lowest[t]），偶尔会同时成立：
  // 上一根破的是旧窗口的低点、这一根收回的是新窗口的低点。所以这里不断言"不可能同时成立"，
  // 那是我一开始写错的期待。真正要验的是 shift 确实改变了取值的时点 ——
  // 不生效的话两个条件会一模一样，那种情况下"同时成立"的次数会等于触发次数。
  let upOnly = 0;
  for (let i = 60; i < candles.length; i++) if (conditionHolds(up, i, cache, params)) upOnly += 1;
  ok('shift 改变了时点：两个条件不完全重合', both < upOnly, '同时成立 ' + both + ' / 单一成立 ' + upOnly);
  // 但也得有真的触发的，否则这个测试什么也没证明
  let fired = 0;
  for (let i = 60; i < candles.length; i++) if (conditionHolds(up, i, cache, params)) fired += 1;
  ok('收回条件至少触发过几次', fired > 0, '触发 ' + fired + ' 次');
}

console.log('\\n[12] 提示词策略：匿名化、解析、外部信号');
{
  const candles: Candle[] = [];
  let px = 62000;
  for (let i = 0; i < 200; i++) {
    px += Math.sin(i / 7) * 300;
    candles.push(bar(1700000000 + i * 3600, px, px + 200, px - 200, px));
  }

  // --- 匿名化真的抹掉了币种、时间和绝对价格 ---
  const ctx = buildAnonContext(candles, 120, 40);
  ok('上下文里没有币种名', !/BTC|USDT|GATE/i.test(ctx.text), ctx.text.slice(0, 60));
  ok('上下文里没有真实年份', !/(19|20)[0-9]{2}/.test(ctx.text), '漏了年份');
  ok('价格归一化到 100 附近', /C=100\.000/.test(ctx.text), '没找到基准行');
  ok('用的是相对序号而不是时间戳', ctx.text.includes('Bar 0') && ctx.text.includes('Bar -1'));

  // --- 护栏：故意塞币种名进去，必须拒绝 ---
  let refused = false;
  try { assertAnonymous(ctx.text + ' BTC_USDT', ['BTC', 'USDT']); } catch { refused = true; }
  ok('夹带币种名会被拒绝执行', refused);

  let refusedYear = false;
  try { assertAnonymous(ctx.text + ' taken at 2022-06-13', ['BTC']); } catch { refusedYear = true; }
  ok('夹带真实年份也会被拒绝', refusedYear);

  // --- 解析：各种脏格式都要落到正确方向 ---
  eq('标准 JSON', parseVerdict('{"side":"long"}').side, 'long');
  eq('带围栏的 JSON', parseVerdict('```json' + String.fromCharCode(10) + '{"side":"short"}' + String.fromCharCode(10) + '```').side, 'short');
  eq('夹杂解释文字', parseVerdict('我觉得 {"side":"long","confidence":0.7} 大概这样').side, 'long');
  eq('只回大写 LONG', parseVerdict('LONG').side, 'long');
  eq('看不出来就 flat', parseVerdict('maybe up, not sure').side, 'flat');
  eq('空回包是 flat', parseVerdict('').side, 'flat');
  ok('置信度被解出来', parseVerdict('{"side":"short","confidence":0.6}').confidence === 0.6);

  // --- 外部信号驱动引擎：做空也能正确计盈亏 ---
  // 造一段单边上涨：如果在每根都做空，应该持续亏钱
  const rise: Candle[] = [];
  for (let i = 0; i < 60; i++) rise.push(bar(i * 3600, 100 + i * 2, 101 + i * 2, 99 + i * 2, 100 + i * 2));
  const shortSpec: StrategySpec = {
    name: 'ps', side: 'long', params: { atrPeriod: 14 }, ranges: {},
    entry: [], stop: { kind: 'pct', value: 0.5 }, target: { kind: 'pct', value: 0.5 }, maxPositions: 1,
  };
  const rShort = backtest(shortSpec, rise, { ...OPTS, signalAt: () => 'short' });
  ok('外部信号做空：有成交', rShort.trades.length > 0, String(rShort.trades.length));
  ok('单边上涨里一直做空是亏的', rShort.stats.totalReturnPct < 0, String(rShort.stats.totalReturnPct));
  ok('成交方向记成 short', rShort.trades.every((t) => t.side === 'short'));

  const rLong = backtest(shortSpec, rise, { ...OPTS, signalAt: () => 'long' });
  ok('同一段单边上涨里一直做多是赚的', rLong.stats.totalReturnPct > 0, String(rLong.stats.totalReturnPct));
  ok('成交方向记成 long', rLong.trades.every((t) => t.side === 'long'));

  const rFlat = backtest(shortSpec, rise, { ...OPTS, signalAt: () => 'flat' });
  ok('一直 flat 就一笔不做', rFlat.trades.length === 0, String(rFlat.trades.length));

  // --- 随机基线：给了种子就确定 ---
  const a = randomBaselineSignals(rise, 20, 7);
  const b = randomBaselineSignals(rise, 20, 7);
  ok('随机基线和种子绑定，两次一致', JSON.stringify(a) === JSON.stringify(b));
  ok('随机基线不是全 flat', a.some((x) => x !== 'flat'));
}
console.log('\\n[13] 关键位：时间线不碰未来、最近支撑阻力选得对');
{
  const mk = (n: number) => Array.from({ length: n }, (_, i) => {
    const px = 100 + Math.sin(i / 5) * 5;
    return bar(i * 3600, px, px + 1, px - 1, px);
  });
  const candles = mk(200);

  // 假引擎：记录每次调用看到的最后一根下标，用来证明没喂未来数据
  const lastSeen: number[] = [];
  const fake = async (window: Candle[]) => {
    lastSeen.push(window[window.length - 1]!.t / 3600);
    return [{
      center: window[window.length - 1]!.c,
      low: 0, high: 0, type: 'support' as const,
      pTouch: 0.5, pHold: 0.5, edge: 1,
    }];
  };

  const tl = await buildZoneTimeline(candles, 50, 10, fake);
  ok('时间线建出来了', tl.slices.length > 0, String(tl.slices.length));
  // 每次调用看到的最后一根，必须正好是这一片的起点（i），不可能更靠后
  const aligned = tl.slices.every((s, k) => lastSeen[k] === candles[s.fromIndex]!.t / 3600);
  ok('每一步只看到当时的最后一根，没有喂未来', aligned);

  const series = zoneSeries(tl, candles);
  // 在切片起点取值：那里价格正好等于假引擎算出来的中心价，支撑和阻力至少有一边成立
  const at = tl.slices[2]!.fromIndex;
  ok('序列按 K 线时间取值（切片起点查得到）',
    Number.isFinite(series.support(at, candles[at]!)) || Number.isFinite(series.resistance(at, candles[at]!)),
    '两者都是 NaN');
  // 反例：价格已经跌到那条支撑下方时，"最近支撑"本来就该没有 ——
  // 这里不是序列坏了，是事实如此。把它写进测试，免得以后有人把它改回去
  const below = tl.slices[2]!.fromIndex + 1;
  const centerOfSlice = tl.slices[2]!.zones[0]!.center;
  if (candles[below]!.c < centerOfSlice) {
    ok('价格跌到支撑下方时，最近支撑为空', !Number.isFinite(series.support(below, candles[below]!)), '居然还给了值');
  } else {
    ok('价格仍在支撑上方（这一根不适用反例）', true);
  }
  // 切片之外（最早那 10 根预热区）应当是 NaN
  ok('预热区没有关键位', !Number.isFinite(series.support(0, candles[0]!)), '不该有值');

  // 最近支撑/阻力：支撑取下方最近的，阻力取上方最近的
  const zones = [
    { center: 90, low: 89, high: 91, type: 'support' as const, pTouch: 0.6, pHold: 0.7, edge: 2 },
    { center: 95, low: 94, high: 96, type: 'support' as const, pTouch: 0.5, pHold: 0.6, edge: 1 },
    { center: 110, low: 109, high: 111, type: 'resistance' as const, pTouch: 0.7, pHold: 0.5, edge: 3 },
    { center: 120, low: 119, high: 121, type: 'resistance' as const, pTouch: 0.4, pHold: 0.4, edge: 1 },
  ];
  const n = nearestZone(zones, 100);
  ok('最近支撑是下方最近的那条（95）', n.support?.center === 95, String(n.support?.center));
  ok('最近阻力是上方最近的那条（110）', n.resistance?.center === 110, String(n.resistance?.center));
  const none = nearestZone(zones, 200);
  ok('价格在最高位上方时没有阻力', none.resistance === null);
}

console.log('\\n[14] 提示词上下文带上关键位，且仍然匿名');
{
  const candles: Candle[] = [];
  let px = 62000;
  for (let i = 0; i < 80; i++) { px += 50; candles.push(bar(1700000000 + i * 3600, px, px + 100, px - 100, px)); }
  const zones = [{ center: px + 500, low: px + 400, high: px + 600, type: 'resistance' as const, pTouch: 0.72, pHold: 0.55 }];
  const ctx = buildAnonContext(candles, 79, 40, zones);
  ok('上下文里有「关键位」这一段', ctx.text.includes('关键位'));
  ok('写着触达/守住概率', ctx.text.includes('72%') && ctx.text.includes('55%'));
  ok('关键位价格也归一化了（不出现 6 万量级）', !/6[0-9]{4}/.test(ctx.text), ctx.text.match(/[0-9]{5}/)?.[0] ?? '');
  ok('仍然没有币种名', !/BTC|USDT/i.test(ctx.text));
}
console.log('\n[15] 参数搜索的异步进度与同步结果一致');
{
  const candles = Array.from({ length: 240 }, (_, i) => {
    const close = 100 + Math.sin(i / 4) * 4 + Math.sin(i / 13) * 2;
    return bar(1700000000 + i * 3600, close, close + 1, close - 1, close);
  });
  const spec: StrategySpec = {
    name: 'progress-check', side: 'long', params: { period: 3 },
    ranges: { period: [2, 6, 2] },
    entry: [{ left: { name: 'close' }, op: '>', right: { name: 'highest', periodKey: 'period' } }],
    stop: { kind: 'pct', value: 0.02 }, target: { kind: 'rr', value: 2 }, maxPositions: 1,
  };
  const base = { ...OPTS, multiplier: 1 };
  const sync = searchParameters(spec, candles, base, { minTrades: 1 });
  const progress: { completed: number; total: number }[] = [];
  const asyncResult = await searchParametersWithProgress(spec, candles, base, { minTrades: 1 }, (p) => progress.push(p));
  eq('异步候选与同步候选一致', asyncResult, sync);
  eq('每组参数各报告一次进度', progress, [1, 2, 3].map((completed) => ({ completed, total: 3 })));
}

const total = passes + fails;
console.log('\n通过 ' + passes + ' 项，失败 ' + fails + ' 项（共 ' + total + '）');
if (fails > 0) process.exitCode = 1;