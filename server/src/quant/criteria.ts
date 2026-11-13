
/**
 * 达标判定。
 *
 * 这是整个回测里唯一有权说"这套策略能用"的地方，所以每一条都写成能看懂的公式，
 * 而不是一个说不清来源的综合分。
 *
 * 默认标准（用户选的）：
 *   · 样本外期望为正          —— 盲测段每笔平均净赚 > 0
 *   · 交易笔数够              —— 盲测段至少 30 笔，少了没有统计意义
 *   · 最大回撤在可接受范围    —— 盲测段 ≤ 25%
 *   · 成本扛得住              —— 手续费和滑点翻 2 倍，盲测段期望仍为正
 *
 * 盈亏比**不在必过项里**，只作为展示。理由写在这里免得以后被人改回去：
 * 盈亏比是「平均盈利 ÷ 平均亏损」，一个胜率 20%、盈亏比 5 的策略照样能亏钱
 * （0.2×5 = 1.0，扣掉手续费就是负的）。拿它当通过标准，等于鼓励把止盈往远放，
 * 回测数字立刻变好看，实盘成交率却在下降。真正该问的是「每笔平均赚不赚钱」。
 */

export interface Criteria {
  /** 盲测段最少几笔 */
  minTrades: number;
  /** 盲测段期望必须为正 */
  requirePositiveExpectancy: boolean;
  /** 盲测段最大回撤上限（%） */
  maxDrawdownPct: number;
  /** 成本翻到这个倍数后，盲测段期望仍要为正 */
  costStressMultiple: number;
  /** 样本外衰减上限（百分点）。训练段比盲测段好太多，说明参数在拟合历史 */
  maxDecayPct: number;
}

export const DEFAULT_CRITERIA: Criteria = {
  minTrades: 30,
  requirePositiveExpectancy: true,
  maxDrawdownPct: 25,
  costStressMultiple: 2,
  maxDecayPct: 3,
};

export interface CriterionResult {
  key: string;
  label: string;
  pass: boolean;
  /** 实测值，原样显示 */
  value: string;
  /** 门槛，原样显示 */
  threshold: string;
  /** 为什么是这条标准 —— 报告页面上直接给用户看 */
  why: string;
}

export interface Verdict {
  passed: boolean;
  /** 未通过的项目；空数组表示全过 */
  failed: CriterionResult[];
  checks: CriterionResult[];
}

export interface ScoredRun {
  blindExpectancyPct: number;
  blindTrades: number;
  blindMaxDrawdownPct: number;
  blindPayoff: number;
  blindWinRate: number;
  decay: number;
  costExpectancy: Record<string, number>;
}

export function judge(run: ScoredRun, criteria: Criteria = DEFAULT_CRITERIA): Verdict {
  const checks: CriterionResult[] = [];

  checks.push({
    key: 'trades',
    label: '交易笔数',
    pass: run.blindTrades >= criteria.minTrades,
    value: String(run.blindTrades),
    threshold: '≥ ' + criteria.minTrades,
    why: '盲测段笔数太少时，胜率和盈亏比都是运气。30 笔是能看出一点苗头的最低量',
  });

  checks.push({
    key: 'expectancy',
    label: '样本外期望',
    pass: criteria.requirePositiveExpectancy ? run.blindExpectancyPct > 0 : true,
    value: run.blindExpectancyPct.toFixed(3) + '% / 笔',
    threshold: '> 0',
    why: '每笔平均净赚（已扣手续费、滑点、资金费）。这是唯一能直接对应「做这个策略赚不赚钱」的数',
  });

  checks.push({
    key: 'drawdown',
    label: '最大回撤',
    pass: run.blindMaxDrawdownPct <= criteria.maxDrawdownPct,
    value: run.blindMaxDrawdownPct.toFixed(2) + '%',
    threshold: '≤ ' + criteria.maxDrawdownPct + '%',
    why: '回撤决定你能不能拿住。期望再正，中途回撤 50% 也大多会提前砍仓',
  });

  const stressed = run.costExpectancy[String(criteria.costStressMultiple)];
  checks.push({
    key: 'cost',
    label: '成本压力 ×' + criteria.costStressMultiple,
    pass: stressed === undefined ? false : stressed > 0,
    value: stressed === undefined ? '没算' : stressed.toFixed(3) + '% / 笔',
    threshold: '> 0',
    why: '把手续费和滑点翻 ' + criteria.costStressMultiple + ' 倍再算。扛不住说明利润全在「成本可能更低」的假设里',
  });

  checks.push({
    key: 'decay',
    label: '样本外衰减',
    pass: run.decay <= criteria.maxDecayPct,
    value: run.decay.toFixed(3) + ' 个百分点',
    threshold: '≤ ' + criteria.maxDecayPct,
    why: '训练段期望减去盲测段期望。差得太多，说明参数是在拟合训练段的历史噪音',
  });

  const failed = checks.filter((c) => !c.pass);
  return { passed: failed.length === 0, failed, checks };
}

/** 只展示、不参与判定的那一组数。放在单独的函数里，免得被顺手塞进 checks */
export function displayOnly(run: ScoredRun): { label: string; value: string; note: string }[] {
  return [
    {
      label: '盈亏比',
      value: run.blindPayoff.toFixed(2),
      note: '平均盈利 ÷ 平均亏损。不设为通过条件：胜率低时它再高也能亏钱，硬卡它等于鼓励把止盈放远',
    },
    {
      label: '胜率',
      value: (run.blindWinRate * 100).toFixed(1) + '%',
      note: '和盈亏比是一起来的，单独看任何一个都会误判',
    },
  ];
}
