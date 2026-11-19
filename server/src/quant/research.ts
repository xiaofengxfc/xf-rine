
/**
 * 一轮研究的编排：提假设 → 搜索 → 判定 → 记下来供下一轮参考。
 *
 * 这是"AI 反复回测直到达标"那句话的实现。几个关键决定：
 *
 *   · **轮数有上限**。模型不会自己停下来，十轮之后大概率在拟合同一段噪音。
 *     到上限就停，并把"没找到"明说 —— 找不到和找到一样是结论。
 *   · **每轮换一个思路的前提是它失败**。历史里带着前几轮为什么没过，
 *     模型拿到的不是"再试试"，而是"哪条路已经走死了"。
 *   · **达标即停**。达标之后再做更多轮，等于在已经合格的方案上继续挑更好看的那份，
 *     那就是过拟合。
 *   · 整轮失败（模型抽风、数据不够）不吞掉：写进记录，继续下一轮，或者停。
 */

import type { Candle, Condition } from './backtest.js';
import { conditionHolds, IndicatorCache } from './backtest.js';
import { searchParametersWithProgress, type Candidate, type SearchOptions } from './search.js';
import { judge, DEFAULT_CRITERIA, type Criteria, type Verdict } from './criteria.js';
import { proposeHypothesis, toSpec, validateSemantics, type Hypothesis, type RoundSummary } from './ai.js';

export interface RunOpts {
  contract: string;
  interval: string;
  candles: Candle[];
  gaps: number;
  market: {
    multiplier: number;
    feeRate: number;
    slippagePct: number;
    capital: number;
    riskPerTrade: number;
    leverage: number;
    fundingRatePer8h: number;
  };
  criteria?: Criteria;
  search?: SearchOptions;
  /** 最多几轮 */
  maxRounds?: number;
  /** 每一轮跑完回调一次，页面上能看见进度 */
  onRound?: (r: RoundSummary) => void;
  /**
   * 细一档的进度播报：模型在想的那一分钟里，页面上也得有东西在动。
   * 只有 onRound 的话，两次回调之间最长能空一分多钟，看着就是「卡在回测中」。
   */
  onStage?: (stage: string, message: string) => void;
  /** 开始跑之前先给出这一轮用的假设，页面先画出来 */
  onHypothesis?: (r: RoundSummary) => void;
  /** 想停就设成 true */
  isCancelled?: () => boolean;
}

export interface ResearchReport {
  contract: string;
  interval: string;
  bars: number;
  days: number;
  gaps: number;
  startedAt: number;
  finishedAt: number;
  rounds: RoundSummary[];
  /** 找到的合格方案。null 表示所有轮次都没找出达标的 */
  winner: { hypothesis: Hypothesis; candidate: Candidate; verdict: Verdict } | null;
  /** 结束原因，直接展示给用户 */
  stopReason: string;
  criteria: Criteria;
  /** 模型在某一轮失败时的说明，不影响结论但要能看见 */
  notes: string[];
}

const DEFAULT_MAX_ROUNDS = 4;

export async function research(opts: RunOpts): Promise<ResearchReport> {
  const criteria = opts.criteria ?? DEFAULT_CRITERIA;
  const maxRounds = Math.max(1, Math.min(10, opts.maxRounds ?? DEFAULT_MAX_ROUNDS));
  const startedAt = Date.now();
  const rounds: RoundSummary[] = [];
  const notes: string[] = [];
  let winner: ResearchReport['winner'] = null;
  let stopReason = '跑完 ' + maxRounds + ' 轮，没有找出达标方案';

  for (let i = 1; i <= maxRounds; i++) {
    if (opts.isCancelled?.()) {
      stopReason = '被中止（第 ' + i + ' 轮之前）';
      break;
    }

    // ---- 1. 提假设 ----
    opts.onStage?.('model', '第 ' + i + ' 轮：让模型提假设（最慢的一步，通常要几十秒）');
    const asked = await proposeHypothesis({
      contract: opts.contract,
      interval: opts.interval,
      bars: opts.candles.length,
      days: (opts.candles[opts.candles.length - 1]!.t - opts.candles[0]!.t) / 86400,
      gaps: opts.gaps,
      rounds,
    });
    if (asked.error) notes.push('第 ' + i + ' 轮：' + asked.error);

    const summary: RoundSummary = {
      round: i,
      hypothesis: asked.hypothesis,
      candidates: 0,
      enoughSample: 0,
      best: null,
      verdict: null,
    };

    /**
     * 先验语义再回测。
     *
     * 一个写得像模像样、实际什么都没筛的条件（比如"收盘 > 前低"，几乎恒真），
     * 跑出来的回测也是有模有样的 —— 那是最坏的情况：数字好看、测的不是那件事。
     * 所以宁可这一轮白提，也把问题指回给模型，让它带着具体提示重写。
     */
    const cache = new IndicatorCache(opts.candles);
    const prices = opts.candles.map((c) => c.c);
    const verify = (c: Condition, idx: number): boolean =>
      conditionHolds(c, idx, cache, summary.hypothesis.params);
    const issues = validateSemantics(
      { thesis: summary.hypothesis.thesis, entry: summary.hypothesis.entry },
      prices,
      verify,
    );
    if (issues.length > 0) {
      summary.semanticIssues = issues.map((x) => ({ code: x.code, message: x.message }));
      notes.push('第 ' + i + ' 轮假设不成立：' + issues.map((x) => x.message).join('；'));
      // 把问题记进历史，下一轮提假设时会看到"这条路这么写是错的"
      summary.hypothesis.whatToValidate = (summary.hypothesis.whatToValidate + ' 【上一版的问题：'
        + issues.map((x) => x.hint).join('；') + '】').slice(0, 400);
      rounds.push(summary);
      opts.onRound?.(summary);
      opts.onStage?.('reject', '第 ' + i + ' 轮：假设写得不成立，退回去重写');
      continue;
    }

    opts.onHypothesis?.(summary);
    opts.onStage?.('search', '第 ' + i + ' 轮：按这个假设跑参数搜索');

    // ---- 2. 搜索 ----
    const spec = toSpec(asked.hypothesis, opts.contract + ' ' + opts.interval + ' #' + i);
    let candidates: Candidate[] = [];
    try {
      candidates = await searchParametersWithProgress(
        spec,
        opts.candles,
        opts.market,
        { ...opts.search, minTrades: criteria.minTrades },
        ({ completed, total }) => {
          const stride = Math.max(1, Math.floor(total / 100));
          if (completed === 1 || completed === total || completed % stride === 0) {
            opts.onStage?.('search', `第 ${i} 轮：参数搜索 ${completed}/${total}`);
          }
        },
        opts.isCancelled,
      );
    } catch (e) {
      notes.push('第 ' + i + ' 轮回测失败：' + (e as Error).message);
    }

    summary.candidates = candidates.length;
    summary.enoughSample = candidates.filter((c) => !c.insufficientSample).length;
    if (candidates.length === 0) {
      opts.onStage?.('search', '第 ' + i + ' 轮：这组条件一个候选都没跑出来，换思路');
    }

    // ---- 3. 判定 ----
    // 只看样本量够的：样本不足的那份排第一也是噪音，拿它去判定等于自己骗自己
    const eligible = candidates.filter((c) => !c.insufficientSample);
    const best = eligible[0] ?? candidates[0] ?? null;
    summary.best = best;
    if (best && eligible.length > 0) {
      summary.verdict = judge({
        blindExpectancyPct: best.blindExpectancyPct,
        blindTrades: best.blindTrades,
        blindMaxDrawdownPct: best.blindMaxDrawdownPct,
        blindPayoff: best.blindPayoff,
        blindWinRate: best.blindWinRate,
        decay: best.decay,
        costExpectancy: best.costExpectancy,
      }, criteria);
    }

    rounds.push(summary);
    opts.onRound?.(summary);

    // ---- 4. 达标就停 ----
    if (summary.verdict?.passed && summary.best) {
      winner = { hypothesis: summary.hypothesis, candidate: summary.best, verdict: summary.verdict };
      stopReason = '第 ' + i + ' 轮找到达标方案';
      break;
    }
    if (opts.isCancelled?.()) {
      stopReason = '被中止（第 ' + i + ' 轮之后）';
      break;
    }
    if (i === maxRounds) {
      stopReason = maxRounds + ' 轮都没达标';
    }
  }

  const first = opts.candles[0]?.t ?? 0;
  const last = opts.candles[opts.candles.length - 1]?.t ?? 0;
  return {
    contract: opts.contract,
    interval: opts.interval,
    bars: opts.candles.length,
    days: (last - first) / 86400,
    gaps: opts.gaps,
    startedAt,
    finishedAt: Date.now(),
    rounds,
    winner,
    stopReason,
    criteria,
    notes,
  };
}

/** 报告里给前端的一句话结论。放在这里，别让页面自己拼措辞 */
export function verdictLine(r: ResearchReport): string {
  if (r.winner) {
    return '找到了：' + r.winner.hypothesis.thesis + '（样本外期望 '
      + r.winner.candidate.blindExpectancyPct.toFixed(3) + '%/笔，'
      + r.winner.candidate.blindTrades + ' 笔）';
  }
  return '没有找到达标方案：' + r.stopReason
    + '。这本身是结论 —— 这些参数范围和规则在这段数据上不值得做。';
}
