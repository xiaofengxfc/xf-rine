
/**
 * 形态条件实验的 CLI。
 *
 *   pnpm stats:patterns-context -- --feature levels
 *   pnpm stats:patterns-context -- --feature levels-engine
 *   pnpm stats:patterns-context -- --feature funding
 *   pnpm stats:patterns-context -- --feature flow
 *   pnpm stats:patterns-context -- --feature strategy
 *
 * 数据默认在 .scratch/pattern-context/cache/ 下；也可以 --bars-dir/--gate-dir/--binance-dir/--levels-dir 指到旧缓存。
 */
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { loadDir, atrSeries, ATR_PERIOD, windows } from './pattern-core.ts';
import { buildDataset, aggregate, line, HEADER, COST, tradeAt, type Bar, type Hit } from './pattern-context-core.ts';
import {
  levelProxyState, engineState, loadEngineTimelines, fundingState, flowState,
  levelGroup, fundingGroup, flowGroup,
} from './pattern-context-features.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_SYMBOLS = [
  'BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'DOGE_USDT', 'XRP_USDT', 'BNB_USDT', 'ADA_USDT', 'LINK_USDT',
  'AVAX_USDT', 'DOT_USDT', 'LTC_USDT', 'TRX_USDT', 'ATOM_USDT', 'UNI_USDT', 'FIL_USDT', 'ETC_USDT',
];
const DEV = new Set(['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'DOGE_USDT', 'XRP_USDT', 'BNB_USDT', 'ADA_USDT', 'LINK_USDT']);
const rel = (p: string): string => (isAbsolute(p) ? p : resolve(ROOT, p));

interface Options {
  feature: 'levels' | 'levels-engine' | 'funding' | 'flow' | 'strategy';
  symbols: string[];
  intervals: string[];
  bars: number;
  barsDir: string;
  gateDir: string;
  binanceDir: string;
  levelsDir: string;
  lookback: number;
  near: number;
}

function parseArgs(argv: string[]): Options {
  const opt: Options = {
    feature: 'levels',
    symbols: DEFAULT_SYMBOLS,
    intervals: ['4h', '1d'],
    bars: 12000,
    barsDir: ROOT + '.scratch/pattern-context/cache/bars',
    gateDir: ROOT + '.scratch/pattern-context/cache/gate',
    binanceDir: ROOT + '.scratch/pattern-context/cache/binance',
    levelsDir: ROOT + '.scratch/pattern-context/cache/levels',
    lookback: 20,
    near: 0.5,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--') continue;
    const next = () => argv[++i] ?? '';
    if (a === '--feature') {
      const v = next();
      if (!['levels', 'levels-engine', 'funding', 'flow', 'strategy'].includes(v)) throw new Error('--feature 只能是 levels|levels-engine|funding|flow|strategy');
      opt.feature = v as Options['feature'];
    } else if (a === '--symbols') opt.symbols = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--intervals') opt.intervals = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--bars') opt.bars = Math.max(500, Number(next()) || 12000);
    else if (a === '--bars-dir') opt.barsDir = rel(next());
    else if (a === '--gate-dir') opt.gateDir = rel(next());
    else if (a === '--binance-dir') opt.binanceDir = rel(next());
    else if (a === '--levels-dir') opt.levelsDir = rel(next());
    else if (a === '--lookback') opt.lookback = Math.max(5, Number(next()) || 20);
    else if (a === '--near') opt.near = Math.max(0.05, Number(next()) || 0.5);
    else throw new Error('不认识的参数：' + a);
  }
  return opt;
}

function show(label: string, list: Hit[], base: Parameters<typeof aggregate>[1]): void {
  console.log(line(label, aggregate(list, base)));
}

function reportGroups(groups: string[], groupOf: (h: Hit) => string, ds: ReturnType<typeof buildDataset>, main: string[]): void {
  console.log(HEADER);
  for (const g of groups) show(g, ds.hits.filter((h) => groupOf(h) === g), ds.base);

  console.log('\n按周期');
  for (const iv of [...new Set(ds.hits.map((h) => h.iv))].sort()) {
    for (const g of main) show(g + '|' + iv, ds.hits.filter((h) => h.iv === iv && groupOf(h) === g), ds.base);
  }

  console.log('\n开发组 / 留出组');
  for (const side of ['dev', 'holdout'] as const) {
    const pool = ds.hits.filter((h) => (side === 'dev') === DEV.has(h.sym));
    for (const g of main) show(g + '|' + side, pool.filter((h) => groupOf(h) === g), ds.base);
  }
}

interface Trade { sym: string; year: number; pnl: number }

function summarize(label: string, list: Trade[]): void {
  if (!list.length) { console.log(label + '\t0'); return; }
  const pnls = list.map((t) => t.pnl).sort((a, b) => a - b);
  const mean = pnls.reduce((s, x) => s + x, 0) / pnls.length;
  const win = pnls.filter((x) => x > 0).length / pnls.length;
  const med = pnls[Math.floor(pnls.length / 2)]!;
  console.log([label, String(pnls.length), mean.toFixed(3), (win * 100).toFixed(1), med.toFixed(3)].join('\t'));
}

function reportStrategy(opt: Options, ds: ReturnType<typeof buildDataset>): void {
  const target = ds.hits.filter((h) => h.iv === opt.intervals[0] && levelGroup(h) === '支撑+看涨');
  const barsMap = new Map<string, Bar[]>();
  const atrMap = new Map<string, number[]>();
  for (const sym of opt.symbols) {
    const b = loadDir(opt.barsDir, sym, opt.intervals[0]!, opt.bars) as Bar[];
    barsMap.set(sym, b);
    atrMap.set(sym, atrSeries(b, ATR_PERIOD));
  }
  const trades: Trade[] = [];
  const bySym = new Map<string, Hit[]>();
  for (const h of target) {
    const list = bySym.get(h.sym) ?? [];
    list.push(h);
    bySym.set(h.sym, list);
  }
  for (const [sym, list] of bySym) {
    const bars = barsMap.get(sym);
    const atr = atrMap.get(sym);
    if (!bars || !atr) continue;
    const seen = new Set<number>();
    const uniq = list.sort((a, b) => a.idx - b.idx).filter((h) => (seen.has(h.idx) ? false : (seen.add(h.idx), true)));
    let nextFree = -1;
    for (const h of uniq) {
      if (h.idx < nextFree) continue;
      const r = tradeAt(bars, atr, h.idx, 1);
      if (!r) continue;
      trades.push({ sym, year: new Date(bars[h.idx]!.time * 1000).getUTCFullYear(), pnl: r.pnl });
      nextFree = r.exit;
    }
  }
  console.log('成交级（同币不重叠）：下一根开盘、2 ATR 止损、持 20 根、成本 ' + (COST * 100).toFixed(2) + '%');
  console.log('组\t笔数\t净ATR/笔\t胜率%\t中位');
  summarize('全部', trades);
  for (const side of ['dev', 'holdout'] as const) summarize(side, trades.filter((t) => (side === 'dev') === DEV.has(t.sym)));
  for (const y of [...new Set(trades.map((t) => t.year))].sort()) summarize(String(y), trades.filter((t) => t.year === y));

  // 同条件、非命中根、同样不重叠的基准
  const baseTrades: Trade[] = [];
  for (const sym of opt.symbols) {
    const bars = barsMap.get(sym);
    const atr = atrMap.get(sym);
    if (!bars || !atr) continue;
    const w = windows(bars.length, 3);
    if (!w.length) continue;
    const hitIdx = new Set((bySym.get(sym) ?? []).map((h) => h.idx));
    const stateOf = levelProxyState(opt.lookback, opt.near);
    let nextFree = -1;
    for (let i = w[0]!.trainEnd; i < w[w.length - 1]!.testEnd; i += 1) {
      if (i < nextFree || hitIdx.has(i)) continue;
      const state = stateOf({ bars, i, atr, atrPct: [], volT: [], iv: opt.intervals[0]!, sym });
      if (state !== 'S') continue;
      const r = tradeAt(bars, atr, i, 1);
      if (!r) continue;
      baseTrades.push({ sym, year: new Date(bars[i]!.time * 1000).getUTCFullYear(), pnl: r.pnl });
      nextFree = r.exit;
    }
  }
  console.log('\n基准：同状态、非命中根、同样不重叠');
  console.log('组\t笔数\t净ATR/笔\t胜率%\t中位');
  summarize('全部', baseTrades);
  for (const side of ['dev', 'holdout'] as const) summarize(side, baseTrades.filter((t) => (side === 'dev') === DEV.has(t.sym)));
}

function main(): void {
  const opt = parseArgs(process.argv.slice(2));
  // 成交级只跑一个周期；把 1d 也带上会把两个周期的命中混进同一张成交表
  if (opt.feature === 'strategy' && opt.intervals.length > 1) {
    opt.intervals = [opt.intervals[0]!];
    console.log('strategy 只跑第一个周期：' + opt.intervals[0]);
  }
  let stateOf;
  let groupOf: (h: Hit) => string;
  let groups: string[];
  let mainGroups: string[];
  let featureName: string;

  if (opt.feature === 'levels' || opt.feature === 'strategy') {
    stateOf = levelProxyState(opt.lookback, opt.near);
    groupOf = levelGroup;
    groups = ['支撑+看涨', '阻力+看跌', '阻力+看涨', '支撑+看跌', '跌破后看涨', '跌破后看跌', '突破后看涨', '中间'];
    mainGroups = ['支撑+看涨', '阻力+看跌', '阻力+看涨', '支撑+看跌', '中间'];
    featureName = '20 根低点/高点代理';
  } else if (opt.feature === 'levels-engine') {
    const timelines = loadEngineTimelines(opt.levelsDir, opt.symbols, opt.intervals);
    const ready = [...timelines.values()].filter(Boolean).length;
    if (ready === 0) throw new Error('没有关键位时间线：' + opt.levelsDir + '。先跑 python sidecar/scripts/export_levels_timeline.py');
    stateOf = engineState(timelines, opt.near);
    groupOf = levelGroup;
    groups = ['支撑+看涨', '阻力+看跌', '阻力+看涨', '支撑+看跌', '中间'];
    mainGroups = groups;
    featureName = '真实引擎关键位（时间线 ' + ready + ' 条）';
  } else if (opt.feature === 'funding') {
    const f = fundingState(opt.gateDir, opt.symbols);
    if (f.ready === 0) throw new Error('没有资金费数据：' + opt.gateDir + '。先跑 pnpm fetch:patterns-context');
    stateOf = f.stateOf;
    groupOf = fundingGroup;
    groups = ['高资金+做空', '低资金+做多', '高资金+做多', '低资金+做空', '资金中性'];
    mainGroups = ['高资金+做空', '低资金+做多', '资金中性'];
    featureName = '资金费 90 天分位（' + f.ready + ' 个币）';
  } else {
    const f = flowState(opt.binanceDir, opt.symbols, opt.intervals);
    if (f.ready === 0) throw new Error('没有 Binance taker buy 数据：' + opt.binanceDir + '。先跑 pnpm fetch:patterns-context');
    stateOf = f.stateOf;
    groupOf = flowGroup;
    groups = ['流量确认', '流量背离', '流量中性'];
    mainGroups = groups;
    featureName = 'Binance taker buy 50 根分位（' + f.ready + ' 条序列）';
  }

  const ds = buildDataset({ cache: opt.barsDir, symbols: opt.symbols, intervals: opt.intervals, stateOf, bars: opt.bars });
  console.log('特征：' + featureName);
  console.log('序列 ' + ds.stats.series + ' 条，命中 ' + ds.stats.keptHits + ' / ' + ds.stats.rawHits + '，阈值 ' + opt.near + ' ATR');
  reportGroups(groups, groupOf, ds, mainGroups);
  if (opt.feature === 'strategy') reportStrategy(opt, ds);
}

main();
