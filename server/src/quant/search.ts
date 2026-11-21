
/**
 * 参数搜索与达标判定。
 *
 * 这一层回答的是"这套规则在这个币上到底行不行"，而且答案必须由代码算出来，
 * 不能由模型说。所以拆成两半：
 *
 *   search.ts   —— 在给定的参数范围里穷举，按验证段表现挑出候选
 *   criteria.ts —— 拿硬指标判它过不过
 *
 * 搜索的三个设计取舍，都是为了不让回测把自己骗过去：
 *
 *   1. **三段切分**：前 70% 训练、中 15% 验证、后 15% 盲测。候选只按训练和验证段筛选，
 *      研究迭代结束后，盲测段只评估选定的候选一次。
 *   2. **成本压力**：验证段用于筛选时跑成本压力，最终盲测也对选定候选检查成本压力。
 *      策略要能承受手续费和滑点高于基准值的情况。
 *   3. **样本外衰减**：训练段与验证段用于迭代筛选，训练段与最终盲测段用于最终判定。
 */

import type { Candle, Params, StrategySpec, BacktestResult, BacktestOpts } from './backtest.js';
import { backtest, warmupOf } from './backtest.js';

/** 一段回测窗口 */
export interface Split {
  /** 训练：用来挑参数 */
  train: Candle[];
  /** 验证：确认不是只在训练段上灵 */
  validate: Candle[];
  /** 验证段第一个允许交易的下标，之前的补充 K 线只用于预热指标。 */
  validateTradeStartIndex: number;
  /** 盲测：全程不参与选择，最终成绩从这里出 */
  blind: Candle[];
  /** 盲测段第一个允许交易的下标，之前的补充 K 线只用于预热指标。 */
  blindTradeStartIndex: number;
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
  const validateStart = Math.max(0, trainEnd - pad);
  const blindStart = Math.max(0, validateEnd - pad);
  return {
    train: candles.slice(0, trainEnd),
    validate: candles.slice(validateStart, validateEnd),
    validateTradeStartIndex: trainEnd - validateStart,
    blind: candles.slice(blindStart),
    blindTradeStartIndex: validateEnd - blindStart,
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
  /** Whether to evaluate the blind segment for each candidate. Defaults to true. */
  evaluateBlind?: boolean;
  /** 验证段少于这么多笔的候选不参与参数选择（仍然会出现在结果里） */
  minTrades?: number;
}

export interface Candidate {
  params: Params;
  /** 训练段：策略期望占初始本金的百分比 */
  trainExpectancyPct: number;
  /** 验证段 */
  validateExpectancyPct: number;
  /** 完整验证段结果，供选定参数和研究轮次使用。 */
  validateResult: BacktestResult;
  validateTrades: number;
  validatePayoff: number;
  validateWinRate: number;
  validateMaxDrawdownPct: number;
  validateReturnPct: number;
  validateDecay: number;
  validateCostExpectancy: Record<string, number>;
  /** Blind values are present only when evaluateBlind is enabled. */
  blindExpectancyPct?: number;
  /** 盲测段的盈亏比（平均盈利 ÷ 平均亏损） */
  blindPayoff?: number;
  blindTrades?: number;
  blindWinRate?: number;
  blindMaxDrawdownPct?: number;
  /** 盲测段总收益率 */
  blindReturnPct?: number;
  /** 训练 - 盲测，衰减越大越可疑 */
  decay?: number;
  /** 各个成本倍数下盲测段的期望（百分比），key 是倍数 */
  costExpectancy?: Record<string, number>;
  /** 综合分，只用来排序；判定看 criteria.ts。样本不足的候选是负的大数 */
  score: number;
  /** 验证段笔数不够，候选不参与参数选择 */
  insufficientSample: boolean;
  /** 盲测段笔数是否不足，最终判定会独立检查盲测笔数。 */
  insufficientBlindSample?: boolean;
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
  const trialLimit = Math.max(1, Math.floor(Number.isFinite(maxTrials) ? maxTrials : 1));

  const axes: number[][] = keys.map((k) => {
    const [min, max, stepRaw] = ranges[k]!;
    const step = stepRaw > 0 ? stepRaw : 1;
    const out: number[] = [];
    // 浮点步长要按小数位对齐，否则 0.1 的步长会走出 0.30000000000000004
    const decimals = (String(step).split('.')[1] ?? '').length;
    const count = Math.max(0, Math.min(200, Math.floor((max - min) / step) + 1));
    for (let i = 0; i < count; i++) {
      out.push(Number((min + step * i).toFixed(decimals)));
    }
    return out;
  });

  const total = axes.reduce((acc, ax) => acc * ax.length, 1);
  if (total === 0) return [];
  if (method === 'grid' && total <= trialLimit) {
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

  // If the random sample covers the entire search space, enumerate all tuples
  // once and shuffle them. This avoids an endless duplicate-retry loop when
  // there are fewer unique tuples than maxTrials.
  if (method === 'random' && total <= trialLimit) {
    const all = expandGrid(base, ranges, 'grid', total, seed);
    const rnd = mulberry32(seed);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [all[i], all[j]] = [all[j]!, all[i]!];
    }
    return all;
  }

  // 组合太多就走随机抽样，并且保证至少把每个轴的最小/最大各试一次
  const rnd = mulberry32(seed);
  const seen = new Set<string>();
  const out: Params[] = [];
  const keyOf = (p: Params) => keys.map((k) => p[k]).join(',');
  const targetCount = Math.min(total, trialLimit);
  for (const extreme of [0, 1]) {
    if (out.length >= targetCount) break;
    const p: Params = { ...base };
    for (let k = 0; k < keys.length; k++) {
      const ax = axes[k]!;
      p[keys[k]!] = extreme === 0 ? ax[0]! : ax[ax.length - 1]!;
    }
    seen.add(keyOf(p));
    out.push(p);
  }
  while (out.length < targetCount) {
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

export interface SearchBase {
  multiplier: number; feeRate: number; slippagePct: number; capital: number;
  /** Equity fraction risked if the stop is hit, e.g. 0.005 means 0.5%. */
  riskPerTrade: number;
  /** Maximum fraction of current equity used as initial margin. Defaults to 40%. */
  maxMarginPct?: number;
  sizeStep?: number;
  sizeMin?: number;
  sizeMax?: number;
  leverage: number; fundingRatePer8h: number;
  leverageMax?: number;
  /** 外部指标（关键位）。要在训练/验证/盲测三段里都生效，所以原样透传 */
  virtual?: BacktestOpts['virtual'];
}

export interface SearchProgress {
  completed: number;
  total: number;
}

function* searchParameterSteps(
  spec: StrategySpec,
  candles: Candle[],
  base: SearchBase,
  opts: SearchOptions,
  isCancelled?: () => boolean,
): Generator<SearchProgress, Candidate[], void> {
  const method = opts.method ?? 'grid';
  const maxTrials = opts.maxTrials ?? 200;
  const multipliers = opts.costMultipliers ?? [1, 1.5, 2, 3];
  const evaluateBlind = opts.evaluateBlind !== false;
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

  for (let index = 0; index < combos.length; index++) {
    if (isCancelled?.()) break;
    const params = combos[index]!;
    const s: StrategySpec = { ...spec, params };
    const runOpts = { ...base, multiplier: base.multiplier };

    const train = backtest(s, split.train, runOpts);
    const validate = backtest(s, split.validate, {
      ...runOpts,
      tradeStartIndex: split.validateTradeStartIndex,
    });
    const blind = evaluateBlind
      ? backtest(s, split.blind, {
          ...runOpts,
          tradeStartIndex: split.blindTradeStartIndex,
        })
      : undefined;

    // Validation metrics may drive research and parameter selection. They are
    // kept separate from the final blind metrics so validation can be used
    // without revealing the blind segment to later research rounds.
    const validateCostExpectancy: Record<string, number> = {};
    for (const m of multipliers) {
      const stressed = backtest(s, split.validate, {
        ...runOpts,
        tradeStartIndex: split.validateTradeStartIndex,
        feeRate: base.feeRate * m,
        slippagePct: base.slippagePct * m,
      });
      validateCostExpectancy[String(m)] = pct(stressed.stats.expectancyPct);
    }

    // Blind costs are evaluated only for workflows that explicitly request
    // blind results. Research rounds should leave this segment untouched.
    const costExpectancy: Record<string, number> | undefined = blind ? {} : undefined;
    if (blind && costExpectancy) {
      for (const m of multipliers) {
        const stressed = backtest(s, split.blind, {
          ...runOpts,
          tradeStartIndex: split.blindTradeStartIndex,
          feeRate: base.feeRate * m,
          slippagePct: base.slippagePct * m,
        });
        costExpectancy[String(m)] = pct(stressed.stats.expectancyPct);
      }
    }

    const validationDecay = train.stats.expectancyPct - validate.stats.expectancyPct;

    /**
     * 候选排序只看验证段。盲测段留给选定参数后的最终判定，不能参与排名。
     * 样本不足的验证结果会留在列表，但不会被推荐。
     */
    const minTrades = opts.minTrades ?? 30;
    const insufficient = validate.stats.trades < minTrades;
    const score = insufficient
      ? -1e6 + validate.stats.trades * 0.01
      : validate.stats.expectancyPct * 1.0 +
        Math.min(validate.stats.payoff, 5) * 0.3 +
        validate.stats.winRate * 0.5 -
        Math.max(0, validationDecay) * 0.5 -
        validate.stats.maxDrawdownPct * 0.05;

    out.push({
      params,
      trainExpectancyPct: pct(train.stats.expectancyPct),
      validateExpectancyPct: pct(validate.stats.expectancyPct),
      validateResult: validate,
      validateTrades: validate.stats.trades,
      validatePayoff: Math.round(validate.stats.payoff * 100) / 100,
      validateWinRate: Math.round(validate.stats.winRate * 1000) / 1000,
      validateMaxDrawdownPct: pct(validate.stats.maxDrawdownPct),
      validateReturnPct: pct(validate.stats.totalReturnPct),
      validateDecay: pct(validationDecay),
      validateCostExpectancy,
      ...(blind ? {
        blindExpectancyPct: pct(blind.stats.expectancyPct),
        blindPayoff: Math.round(blind.stats.payoff * 100) / 100,
        blindTrades: blind.stats.trades,
        blindWinRate: Math.round(blind.stats.winRate * 1000) / 1000,
        blindMaxDrawdownPct: pct(blind.stats.maxDrawdownPct),
        blindReturnPct: pct(blind.stats.totalReturnPct),
        decay: pct(train.stats.expectancyPct - blind.stats.expectancyPct),
        costExpectancy,
        insufficientBlindSample: blind.stats.trades < minTrades,
        blindResult: blind,
      } : {}),
      score: Math.round(score * 1000) / 1000,
      insufficientSample: insufficient,
    });
    yield { completed: index + 1, total: combos.length };
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Evaluate only the selected parameter set on the untouched blind window. */
export function evaluateBlindCandidate(
  spec: StrategySpec,
  candles: Candle[],
  base: SearchBase,
  selected: Candidate,
  opts: SearchOptions = {},
): Candidate {
  if (selected.blindResult) return selected;

  const method = opts.method ?? 'grid';
  const maxTrials = opts.maxTrials ?? 200;
  const combos = expandGrid(spec.params, spec.ranges, method, maxTrials, opts.seed ?? 42);
  let maxWarmup = warmupOf(spec);
  for (const params of combos) {
    maxWarmup = Math.max(maxWarmup, warmupOf({ ...spec, params }));
  }
  const split = splitCandles(candles, maxWarmup);
  const selectedSpec: StrategySpec = { ...spec, params: selected.params };
  const runOpts = { ...base, multiplier: base.multiplier, tradeStartIndex: split.blindTradeStartIndex };
  const blind = backtest(selectedSpec, split.blind, runOpts);
  const costExpectancy: Record<string, number> = {};
  for (const multiple of opts.costMultipliers ?? [1, 1.5, 2, 3]) {
    const stressed = backtest(selectedSpec, split.blind, {
      ...runOpts,
      feeRate: base.feeRate * multiple,
      slippagePct: base.slippagePct * multiple,
    });
    costExpectancy[String(multiple)] = pct(stressed.stats.expectancyPct);
  }

  const train = backtest(selectedSpec, split.train, { ...base, multiplier: base.multiplier });
  const minTrades = opts.minTrades ?? 30;
  return {
    ...selected,
    blindExpectancyPct: pct(blind.stats.expectancyPct),
    blindPayoff: Math.round(blind.stats.payoff * 100) / 100,
    blindTrades: blind.stats.trades,
    blindWinRate: Math.round(blind.stats.winRate * 1000) / 1000,
    blindMaxDrawdownPct: pct(blind.stats.maxDrawdownPct),
    blindReturnPct: pct(blind.stats.totalReturnPct),
    decay: pct(train.stats.expectancyPct - blind.stats.expectancyPct),
    costExpectancy,
    insufficientBlindSample: blind.stats.trades < minTrades,
    blindResult: blind,
  };
}

export function searchParameters(
  spec: StrategySpec,
  candles: Candle[],
  base: SearchBase,
  opts: SearchOptions = {},
): Candidate[] {
  const steps = searchParameterSteps(spec, candles, base, opts);
  while (true) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Async counterpart used by progress-streaming routes; yields between trials. */
export async function searchParametersWithProgress(
  spec: StrategySpec,
  candles: Candle[],
  base: SearchBase,
  opts: SearchOptions = {},
  onProgress?: (progress: SearchProgress) => void,
  isCancelled?: () => boolean,
): Promise<Candidate[]> {
  const steps = searchParameterSteps(spec, candles, base, opts, isCancelled);
  while (true) {
    const next = steps.next();
    if (next.done) return next.value;
    onProgress?.(next.value);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
