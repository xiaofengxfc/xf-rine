
/**
 * 参数搜索与达标判定。
 *
 * 这一层回答的是"这套规则在这个币上到底行不行"，而且答案必须由代码算出来，
 * 不能由模型说。所以拆成两半：
 *
 *   search.ts   —— 在给定的参数范围里穷举，按样本外表现挑出最好的那几个
 *   criteria.ts —— 拿硬指标判它过不过
 *
 * 搜索的三个设计取舍，都是为了不让回测把自己骗过去：
 *
 *   1. **三段切分**：前 70% 训练、中 15% 验证、后 15% 盲测。参数只在训练段上选，
 *      选完在验证段上确认，最后在盲测段上算最终成绩。盲测段从头到尾没参与选择，
 *      它给出的数字才有资格叫"这个策略的预期"。
 *   2. **成本压力**：同样的参数，把手续费和滑点翻 1、1.5、2、3 倍再跑。
 *      扛不住的成本翻倍，说明利润全在"手续费可能不收"的假设里。
 *   3. **OOS 衰减**：训练段表现减去盲测段表现。衰减太大说明参数是在拟合历史噪音。
 */

import type { Candle, Params, StrategySpec, BacktestResult, BacktestOpts } from './backtest.js';
import { backtest, warmupOf } from './backtest.js';

/** 一段回测窗口 */
export interface Split {
  /** 训练：用来挑参数 */
  train: Candle[];
  /** 验证：确认不是只在训练段上灵 */
  validate: Candle[];
  /** 盲测：全程不参与选择，最终成绩从这里出 */
  blind: Candle[];
}

/**
 * 三段切分。
 *
 * `warmup` 是要给每一段前面补多少根历史。这个数必须由调用方按策略给 ——
 * 以前这里写死 60，慢线 EMA(110) 光预热就要 110 根，盲测段（总长度的 15%）整段都在预热里，
 * 一百多个候选最后各自只剩两三笔交易，所有候选看起来都"不达标"，但那不是策略的问题，
 * 是窗口被预热吃掉了。引擎不会替你补，它只保证不给未来数据。
 *
 * 补进来的那几根只用于算指标，它们的交易不计入这一段 —— 引擎从第一根就开始判断信号，
 * 所以补的根数要够把预热期撑过去，宁可多补。
 */
export function splitCandles(
  candles: Candle[],
  warmup: number,
  trainRatio = 0.7,
  validateRatio = 0.15,
): Split {
  const n = candles.length;
  const pad = Math.max(0, Math.ceil(warmup));
  const trainEnd = Math.floor(n * trainRatio);
  const validateEnd = Math.floor(n * (trainRatio + validateRatio));
  return {
    train: candles.slice(0, trainEnd),
    validate: candles.slice(Math.max(0, trainEnd - pad), validateEnd),
    blind: candles.slice(Math.max(0, validateEnd - pad)),
  };
}

export interface SearchOptions {
  /** 枚举方法：grid 全组合；random 随机抽样 */
  method?: 'grid' | 'random';
  /** 最多试多少组 */
  maxTrials?: number;
  /** 成本倍数：默认 1/1.5/2/3，越大越苛刻 */
  costMultipliers?: number[];
  /** 随机种子，保证同一份数据同一个结果 */
  seed?: number;
  /** 盲测段少于这么多笔的候选不参与排名（仍然会出现在结果里，标成样本不足） */
  minTrades?: number;
}

export interface Candidate {
  params: Params;
  /** 训练段：策略期望占初始本金的百分比 */
  trainExpectancyPct: number;
  /** 验证段 */
  validateExpectancyPct: number;
  /** 盲测段 —— 只用来排名和判定，不参与挑选 */
  blindExpectancyPct: number;
  /** 盲测段的盈亏比（平均盈利 ÷ 平均亏损） */
  blindPayoff: number;
  blindTrades: number;
  blindWinRate: number;
  blindMaxDrawdownPct: number;
  /** 盲测段总收益率 */
  blindReturnPct: number;
  /** 训练 - 盲测，衰减越大越可疑 */
  decay: number;
  /** 各个成本倍数下盲测段的期望（百分比），key 是倍数 */
  costExpectancy: Record<string, number>;
  /** 综合分，只用来排序；判定看 criteria.ts。样本不足的候选是负的大数 */
  score: number;
  /** 盲测段笔数不够，这一份结果不能当结论用 */
  insufficientSample: boolean;
  /** 盲测段完整结果，报告里要画权益曲线 */
  blindResult?: BacktestResult;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把参数范围展开成候选组合。网格是笛卡尔积，随机是抽样 */
export function expandGrid(
  base: Params,
  ranges: Record<string, [number, number, number]>,
  method: 'grid' | 'random',
  maxTrials: number,
  seed: number,
): Params[] {
  const keys = Object.keys(ranges);
  if (keys.length === 0) return [base];

  const axes: number[][] = keys.map((k) => {
    const [min, max, stepRaw] = ranges[k]!;
    const step = stepRaw > 0 ? stepRaw : 1;
    const out: number[] = [];
    // 浮点步长要按小数位对齐，否则 0.1 的步长会走出 0.30000000000000004
    const decimals = (String(step).split('.')[1] ?? '').length;
    const count = Math.min(200, Math.floor((max - min) / step) + 1);
    for (let i = 0; i < count; i++) {
      out.push(Number((min + step * i).toFixed(decimals)));
    }
    return out;
  });

  const total = axes.reduce((acc, ax) => acc * Math.max(1, ax.length), 1);
  if (method === 'grid' && total <= maxTrials) {
    const combos: Params[] = [];
    const idx = new Array(keys.length).fill(0);
    // 用 odometer 而不是递归：组合数大时递归会把栈吃光
    for (let n = 0; n < total; n++) {
      const p: Params = { ...base };
      for (let k = 0; k < keys.length; k++) p[keys[k]!] = axes[k]![idx[k]!]!;
      combos.push(p);
      for (let k = keys.length - 1; k >= 0; k--) {
        idx[k]! += 1;
        if (idx[k]! < axes[k]!.length) break;
        idx[k] = 0;
      }
    }
    return combos;
  }

  // 组合太多就走随机抽样，并且保证至少把每个轴的最小/最大各试一次
  const rnd = mulberry32(seed);
  const seen = new Set<string>();
  const out: Params[] = [];
  const keyOf = (p: Params) => keys.map((k) => p[k]).join(',');
  for (const extreme of [0, 1]) {
    const p: Params = { ...base };
    for (let k = 0; k < keys.length; k++) {
      const ax = axes[k]!;
      p[keys[k]!] = extreme === 0 ? ax[0]! : ax[ax.length - 1]!;
    }
    seen.add(keyOf(p));
    out.push(p);
  }
  while (out.length < maxTrials) {
    const p: Params = { ...base };
    for (let k = 0; k < keys.length; k++) {
      const ax = axes[k]!;
      p[keys[k]!] = ax[Math.floor(rnd() * ax.length)]!;
    }
    const k = keyOf(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

const pct = (v: number): number => Math.round(v * 100) / 100;

export function searchParameters(
  spec: StrategySpec,
  candles: Candle[],
  base: {
    multiplier: number; feeRate: number; slippagePct: number; capital: number;
    riskPerTrade: number; leverage: number; fundingRatePer8h: number;
    /** 外部指标（关键位）。要在训练/验证/盲测三段里都生效，所以原样透传 */
    virtual?: BacktestOpts['virtual'];
  },
  opts: SearchOptions = {},
): Candidate[] {
  const method = opts.method ?? 'grid';
  const maxTrials = opts.maxTrials ?? 200;
  const multipliers = opts.costMultipliers ?? [1, 1.5, 2, 3];
  // 预热按"最慢的那个候选"算：范围里最大的周期决定要补多少根
  const warmup = warmupOf(spec);
  const combos = expandGrid(spec.params, spec.ranges, method, maxTrials, opts.seed ?? 42);
  let maxWarmup = warmup;
  for (const c of combos) {
    const w = warmupOf({ ...spec, params: c });
    if (w > maxWarmup) maxWarmup = w;
  }
  const split = splitCandles(candles, maxWarmup);
  const out: Candidate[] = [];

  for (const params of combos) {
    const s: StrategySpec = { ...spec, params };
    const runOpts = { ...base, multiplier: base.multiplier };

    const train = backtest(s, split.train, runOpts);
    const validate = backtest(s, split.validate, runOpts);
    const blind = backtest(s, split.blind, runOpts);
    if (blind.stats.trades === 0) continue;

    // 成本压力只在盲测段上跑：这一段没参与过选择，翻倍的代价在这里才算数
    const costExpectancy: Record<string, number> = {};
    for (const m of multipliers) {
      const stressed = backtest(s, split.blind, {
        ...runOpts,
        feeRate: base.feeRate * m,
        slippagePct: base.slippagePct * m,
      });
      costExpectancy[String(m)] = pct(stressed.stats.expectancyPct);
    }

    const decay = train.stats.expectancyPct - blind.stats.expectancyPct;

    /**
     * 排序分。
     *
     * 样本量不足的候选一律压到最底下 —— 这一条是实测撞出来的：RSI 超卖只成交 1 笔、
     * 那一笔恰好吃到 +4.5%，综合分把它排到了第一名。一笔交易的"期望"就是那一笔本身，
     * 它排在第二名的理由只有一个：样本太少，噪声最大。
     *
     * 所以：
     *   · 盲测段笔数 < minTrades 时，score 直接取负无穷大的替代值（-1e6），
     *     它仍然留在结果里，报告上写清"样本不足"，但不会被当成推荐方案。
     *   · 样本够的时候，才按期望、盈亏比、衰减、回撤这几项加权。
     */
    const minTrades = opts.minTrades ?? 30;
    const insufficient = blind.stats.trades < minTrades;
    const score = insufficient
      ? -1e6 + blind.stats.trades * 0.01 // 不足的不参与竞争，但仍按笔数排个先后方便查看
      : blind.stats.expectancyPct * 1.0 +
        Math.min(blind.stats.payoff, 5) * 0.3 +
        blind.stats.winRate * 0.5 -
        Math.max(0, decay) * 0.5 -
        blind.stats.maxDrawdownPct * 0.05;

    out.push({
      params,
      trainExpectancyPct: pct(train.stats.expectancyPct),
      validateExpectancyPct: pct(validate.stats.expectancyPct),
      blindExpectancyPct: pct(blind.stats.expectancyPct),
      blindPayoff: Math.round(blind.stats.payoff * 100) / 100,
      blindTrades: blind.stats.trades,
      blindWinRate: Math.round(blind.stats.winRate * 1000) / 1000,
      blindMaxDrawdownPct: pct(blind.stats.maxDrawdownPct),
      blindReturnPct: pct(blind.stats.totalReturnPct),
      decay: pct(decay),
      costExpectancy,
      score: Math.round(score * 1000) / 1000,
      insufficientSample: insufficient,
      blindResult: blind,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
