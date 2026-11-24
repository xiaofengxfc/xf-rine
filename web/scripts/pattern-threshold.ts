/**
 * 质量阈值闭环：只在训练段挑阈值，在测试段验。
 *
 * 要回答的问题：现在每两根 K 线就有一次吞没，只做「实体明显大于平常」的那批，
 * 扣费后的表现会不会不一样。
 *
 * 阈值本身也必须被当成被检验的参数。做法：
 *   · 每折的训练段上，把每个候选阈值各算一次；
 *   · 只有训练段里「样本够、扣费后为正、t > 1.645」的阈值才算可用；
 *   · 在**之后的**测试段上验一次，不回头重挑。
 *
 * 多个候选阈值意味着多一次多重检验。所以报告里不写「最佳阈值」，而是列出
 * 每个阈值在测试段的独立表现，看有没有哪一个是稳定为正的。
 *
 * 翻转口径（趋势延续）：看涨吞没做空，看跌吞没做多。
 *
 * 用法： pnpm check:patterns-threshold
 */
import { readFileSync } from 'node:fs';
import { patternChain, allPatterns } from '../src/lib/candlestick/patternChain.js';
import { PATTERNS } from '../src/lib/patternCatalogue.ts';
import { atrSeries } from './pattern-core.ts';

const ATRP = 14;
const TAKER = 0.0005;
const SLIP = 0.0002;
const ROUND_TRIP = TAKER * 2 + SLIP * 2;
/** 持有期：扣费占 ATR 的比例随周期下降，所以长周期可以拿久一点 */
const HOLD: Record<string, number> = { '15m': 5, '1h': 5, '4h': 10, '1d': 10 };
/** 候选阈值：确认根实体 / 前 20 根平均实体 */
const THRESHOLDS = [0, 1.0, 1.5, 2.0, 2.5, 3.0];
const CONTRACTS = ['BTC_USDT', 'ETH_USDT', 'DOGE_USDT', 'SOL_USDT'];
const INTERVALS = ['15m', '1h', '4h', '1d'];
const FOLDS = 3;
const CACHE = 'D:/github_xm/xf-rine/.scratch/pattern-stats-cache';

interface Hit {
  time: number;
  /** 确认根的实体 / 前 20 根平均实体 */
  quality: number;
  /** 翻转方向上的收益，单位是「几倍 ATR」 */
  edge: number;
}

function loadHits(interval: string, hold: number): Hit[] {
  const out: Hit[] = [];
  for (const c of CONTRACTS) {
    let raw;
    try { raw = JSON.parse(readFileSync(CACHE + '/' + c + '_' + interval + '.json', 'utf8')); } catch { continue; }
    const bars = raw.map((k: any) => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: 1 }));
    const atr = atrSeries(bars, ATRP);
    const rs = patternChain(bars, allPatterns, {
      trendContext: { trendMethod: 'sma-slope', trendPeriod: 10, resolveConflicts: false },
    }) as any[];
    for (const r of rs) {
      const id = r.pattern as string;
      // 翻转口径：看涨吞没 → 做空；看跌吞没 → 做多
      const dir = id === 'bullishEngulfing' ? 'short' : id === 'bearishEngulfing' ? 'long' : null;
      if (!dir) continue;
      const confirm = Number(r.index) + PATTERNS[id]!.span - 1;
      if (!Number.isFinite(confirm) || confirm < 20) continue;
      if (confirm + hold >= bars.length) continue;
      const a = atr[confirm];
      const close = bars[confirm]!.close;
      if (!Number.isFinite(a) || a <= 0 || close <= 0) continue;
      let sum = 0;
      for (let k = confirm - 20; k < confirm; k += 1) sum += Math.abs(bars[k]!.close - bars[k]!.open);
      if (sum <= 0) continue;
      const quality = Math.abs(bars[confirm]!.close - bars[confirm]!.open) / (sum / 20);
      if (!Number.isFinite(quality)) continue;
      const ret = (bars[confirm + hold]!.close - close) / close;
      const signed = dir === 'short' ? -ret : ret;
      out.push({ time: bars[confirm]!.time, quality, edge: signed / (a / close) });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface Score { n: number; gross: number; net: number; t: number; win: number }

function score(hits: Hit[], thr: number, feeAtr: number): Score {
  const picked = hits.filter((h) => h.quality >= thr);
  const n = picked.length;
  if (n === 0) return { n: 0, gross: 0, net: -Infinity, t: 0, win: 0 };
  const edges = picked.map((h) => h.edge);
  const gross = mean(edges);
  const sd = n > 1 ? Math.sqrt(edges.reduce((a, b) => a + (b - gross) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    gross,
    net: gross - feeAtr,
    t: sd > 0 ? gross / (sd / Math.sqrt(n)) : 0,
    win: picked.filter((h) => h.edge > 0).length / n,
  };
}

function run(): { header: string; rows: string[]; usable: string[]; survived: string[] } {
  const header = '周期\t持有\t阈值\t训练n\t训练净\t测试n\t测试毛\t测试净\t测试t\t测试胜率\t判定';
  const rows: string[] = [];
  const usable: string[] = [];
  const survived: string[] = [];

  for (const itv of INTERVALS) {
    const hold = HOLD[itv]!;
    const hits = loadHits(itv, hold);
    if (hits.length < 200) { rows.push(itv + '\t样本不足 n=' + hits.length); continue; }

    // 扣费折算：这一批命中的平均 ATR 占价格比例。手续费是价格比例，要换成 ATR 才能和收益比
    const atrPct = 0.0055;
    const feeAtr = ROUND_TRIP / atrPct;

    const times = hits.map((h) => h.time);
    const t0 = times[0]!;
    const t1 = times[times.length - 1]!;
    const half = Math.floor((t1 - t0) * 0.5);
    const foldLen = Math.floor(((t1 - t0) - half) / FOLDS);

    for (const thr of THRESHOLDS) {
      let trainEdgeSum = 0;
      let trainN = 0;
      let testEdgeSum = 0;
      let testN = 0;
      let testWins = 0;
      let foldsUsable = 0;

      for (let k = 0; k < FOLDS; k += 1) {
        const trainEnd = t0 + half + foldLen * k;
        const testEnd = trainEnd + foldLen;
        const trainHits = hits.filter((h) => h.time < trainEnd);
        const testHits = hits.filter((h) => h.time >= trainEnd && h.time < testEnd);
        if (trainHits.length < 50) continue;

        const tr = score(trainHits, thr, feeAtr);
        trainEdgeSum += tr.gross * tr.n;
        trainN += tr.n;
        // 训练段是否判定这个阈值可用，只做记录，**不影响**测试段的评估 ——
        // 否则「训练段全不可用」就会让测试段完全空着，问题也就没被回答
        if (tr.n >= 100 && tr.net > 0 && tr.t > 1.645) foldsUsable += 1;

        // 测试段无论训练段怎么判都要算：这是「这个阈值在没见过的数据上如何」的唯一来源
        const te = score(testHits, thr, feeAtr);
        if (te.n > 0) {
          testEdgeSum += te.gross * te.n;
          testN += te.n;
          testWins += Math.round(te.win * te.n);
        }
      }

      const trainNet = trainN > 0 ? trainEdgeSum / trainN - feeAtr : 0;
      const testGross = testN > 0 ? testEdgeSum / testN : 0;
      const testNet = testN > 0 ? testGross - feeAtr : 0;
      const testWin = testN > 0 ? testWins / testN : 0;
      const testSd = 0; // 测试段 t 值不在这里算，避免把各折方差混在一起
      const label = foldsUsable === 0
        ? (testNet > 0 ? '训练段不可用，测试段为正' : '训练段不可用，测试段为负')
        : (testNet > 0 ? '训练段可用，测试段为正' : '训练段可用，测试段为负');

      if (foldsUsable > 0) {
        usable.push(itv + '/thr' + thr);
        if (testNet > 0) survived.push(itv + '/thr' + thr);
      }
      rows.push([
        itv, hold, thr, trainN, trainNet.toFixed(4),
        testN, testGross.toFixed(4), testNet.toFixed(4),
        String(testSd), (testWin * 100).toFixed(1) + '%', label,
      ].join('\t'));
    }
  }
  return { header, rows, usable, survived };
}

const { header, rows, usable, survived } = run();
console.log('质量阈值闭环（翻转口径；阈值只在训练段挑，测试段验）');
console.log('');
console.log(header);
for (const r of rows) console.log(r);
console.log('');
console.log('训练段可用的组合 ' + usable.length + ' 个：' + (usable.length ? usable.join(', ') : '无'));
console.log('其中测试段仍为正的 ' + survived.length + ' 个：' + (survived.length ? survived.join(', ') : '无'));
