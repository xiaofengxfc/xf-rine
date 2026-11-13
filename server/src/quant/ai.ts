
/**
 * AI 提策略假设。
 *
 * 这个文件只做一件事：把"回测报告"和"数据概况"交给模型，让它提下一版假设
 * （用哪几个指标、什么逻辑、参数范围给多宽）。它**不做判定** ——
 * 过不过由 criteria.ts 算，模型连"通过"这个词都不该看到。
 *
 * 为什么不让模型直接写代码：模型写的代码要执行，执行就意味着这个进程里跑一段
 * 根据外部文本生成的逻辑，而那段逻辑读的是真钱账户旁边的配置。折中方案是
 * 让模型在**固定的指标集合**里挑组合、给范围 —— 表达力已经够覆盖均线、突破、
 * 超买超卖、摆动位这几大类，又没有执行任意代码的风险。
 *
 * 模型给的东西一律先过 sanitizeHypothesis()：指标名必须在内置清单里、
 * 参数范围必须在允许的区间内、条件必须是已知算子。不合格就退回默认，不报错崩掉。
 */

import { config } from '../config.js';
import { INDICATORS } from './indicators.js';
import type { Condition, IndicatorRef, Params, StrategySpec } from './backtest.js';
import type { Candidate } from './search.js';
import type { Verdict } from './criteria.js';

/** 能选的指标名，来自 indicators.ts，单一来源 */
const KNOWN_INDICATORS = new Set(INDICATORS.map((i) => i.id));
/** 能选的算子 */
const KNOWN_OPS = new Set(['>', '<', '>=', '<=', 'crossUp', 'crossDown']);
/** 周期参数的合理范围：太大等于没有信号，太小等于噪音 */
const PERIOD_MIN = 2;
const PERIOD_MAX = 400;
/** 一次最多几条入场条件 */
const MAX_CONDITIONS = 3;

export interface Hypothesis {
  /** 这一版假设用一句话说清在赌什么 */
  thesis: string;
  side: 'long' | 'short';
  params: Params;
  ranges: Record<string, [number, number, number]>;
  entry: Condition[];
  stop: { kind: 'atr' | 'pct'; value: number };
  target: { kind: 'atr' | 'pct' | 'rr'; value: number };
  /** 模型认为这一版想验证什么，报告里单独列出来 */
  whatToValidate: string;
  /** 这一版是从哪里来的：模型新提，还是从上一轮的失败里改 */
  origin: 'first' | 'revise';
}

export interface RoundSummary {
  round: number;
  hypothesis: Hypothesis;
  /** 跑出来的候选数、其中有多少样本量够 */
  candidates: number;
  enoughSample: number;
  /** 最好的那一份（按 score 排，样本不足的排最后） */
  best: Candidate | null;
  verdict: Verdict | null;
  /** 这一轮假设没通过语义校验时，这里写原因。有值就说明没跑回测 */
  semanticIssues?: { code: string; message: string }[];
}

const SYSTEM = `你是一个量化研究员。你的工作是提一个**可回测的规则假设**，不是给交易建议。

你会收到两样东西：
1. 数据概况：合约、周期、有多少根 K 线、覆盖多少天、有没有断档。
2. 之前的尝试记录：每一轮提了什么假设、回测出来什么结果、为什么没过。

你要给出**下一版假设**。规则：
- 只从给定的指标清单里选。不要在清单外发明指标。
- 入场条件最多 3 条，条件是 AND 关系，全部成立才开仓。
- 参数范围要"窄到能搜完、宽到有意义"：每个参数给 [最小, 最大, 步长]，组合数控制在 200 以内。
- 如果之前几轮都在亏，换一个思路，不要在同一族参数上继续微调 —— 那只是在拟合噪音。
- 不要求你预测盈利。你只负责提一个**值得测**的假设，测出来不行也没关系。

## 输出格式（这是硬约束）
只输出一个 JSON 对象，除非结构完全匹配，否则系统会判定失败并让你重写。

**必须恰好有这些顶层字段，多一个少一个都不行**：thesis, side, params, ranges, entry, stop, target, whatToValidate

- params 必须是对象，形如 {"emaFast": 10}，值是数字。
- entry 必须是数组，每个元素是对象。不要把 entry 写成 {"long": {...}} 这种按方向分组的形式，也不要写成字符串。
- 每个 entry 元素只能有 left / op / right（可选 rightConstant / shift / rightShift）这几个键。
- ranges 必须是对象，值是长度为 3 的数组。
- 不允许出现 name / hypothesis / indicators / exit / parameters / validation / risks 这些字段。想说的话全部放进 thesis 和 whatToValidate。

不正确（会被打回）：
{"hypothesis": "...", "indicators": [...], "entry": {"long": {"condition": "close > highest"}}, "parameters": {...}}

正确：
{
  "thesis": "一句话，这一版在赌什么样的价格行为",
  "side": "long",
  "params": {
    "fast": 10,
    "slow": 40,
    "atrPeriod": 14
  },
  "ranges": {
    "fast": [5, 25, 5],
    "slow": [30, 100, 10]
  },
  "entry": [
    { "left": "fast", "op": "crossUp", "right": "slow" }
  ],
  "stop": { "kind": "atr", "value": 1.5 },
  "target": { "kind": "rr", "value": 2 },
  "whatToValidate": "一句话，这一版想验证什么"
}

上面这个例子的读法是：params 里的**每个键就是一个参数名**，值是这个参数在"没搜索时"的默认数；
指标写在 entry 里，用参数名指过去 —— 比如 "fast" 对应 params.fast 那个周期。
不要用 "indicators" 数组，不要用字符串写条件，index 不要编造清单外的指标名。

**表达形态要用 shift。** 条件里可以加 "shift": 1，表示"用上一根的值"。

下面四个写法已经验证过能跑，照着抄，只改参数名：

A. 突破前高追多
  "params": { "n": 20, "atrPeriod": 14 }
  "entry": [{ "left": "close", "op": ">", "right": "n" }]
  —— 这里 right 写参数名 n，系统知道 n 是"前 n 根最高价"

B. 跌破前低又收回（假跌破）
  "params": { "n": 20, "atrPeriod": 14 }
  "entry": [
    { "left": "close", "op": "<", "right": "n", "shift": 1 },
    { "left": "close", "op": ">", "right": "n" }
  ]

C. 均线金叉
  "params": { "emaFast": 10, "emaSlow": 40, "atrPeriod": 14 }
  "entry": [{ "left": "emaFast", "op": "crossUp", "right": "emaSlow" }]

D. 超卖反弹
  "params": { "rsiPeriod": 14, "rsiLevel": 30, "atrPeriod": 14 }
  "entry": [{ "left": "rsi", "op": "<", "right": "close", "rightConstant": "rsiLevel" }]

绝对不要写下面这些（它们会变成 close > close，等于没有条件）：
  { "left": "close", "op": ">", "right": "close" }
  { "left": "close", "op": ">", "right": "trendPeriod" }
left 和 right 里放的必须是**参数名**或 close；不是参数名的东西系统认不出来。

再举一个带常数的例子（RSI 低于 30 才进）：
{
  "thesis": "超卖之后反弹",
  "side": "long",
  "params": { "rsiPeriod": 14, "threshold": 30, "atrPeriod": 14 },
  "ranges": { "rsiPeriod": [7, 21, 7], "threshold": [25, 35, 5] },
  "entry": [{ "left": "rsiPeriod", "op": "<", "right": "close", "rightConstant": "threshold" }],
  "stop": { "kind": "atr", "value": 2 },
  "target": { "kind": "rr", "value": 2 },
  "whatToValidate": "超卖反弹有没有足够的赔率"
}

注意：left / right 里写的是**参数名**，系统靠它找到对应的指标和周期。
参数名和指标名的对应关系写在指标清单的括号里（比如 ema 的 period）。
如果某个参数名本身不是指标名，就必须在 entry 里被用到，否则它没有任何意义。`;

export function indicatorCatalogText(): string {
  return INDICATORS.map((i) => {
    const ps = i.params.map((p) => p.name + '(默认' + p.def + ')').join(', ');
    return '- ' + i.id + '：' + i.label + (ps ? '（参数：' + ps + '）' : '（无参数）');
  }).join('\n');
}

/** 把之前几轮压成一段，模型要能看出"哪条路已经走死了" */
export function historyText(rounds: RoundSummary[]): string {
  if (rounds.length === 0) return '（这是第一轮，没有历史）';
  return rounds.map((r) => {
    const lines = [
      '第 ' + r.round + ' 轮：' + r.hypothesis.thesis,
      '  条件 ' + r.hypothesis.entry.map((c) => describeCondition(c)).join(' 且 '),
      '  候选 ' + r.candidates + ' 组，样本量够的 ' + r.enoughSample + ' 组',
    ];
    if (r.best) {
      lines.push(
        '  最好的一份：样本外期望 ' + r.best.blindExpectancyPct.toFixed(3) + '%/笔，'
        + r.best.blindTrades + ' 笔，盈亏比 ' + r.best.blindPayoff + '，回撤 ' + r.best.blindMaxDrawdownPct.toFixed(1) + '%',
      );
    } else {
      lines.push('  没有任何一组成交');
    }
    if (r.verdict) {
      lines.push(
        r.verdict.passed
          ? '  结论：达标'
          : '  未通过：' + r.verdict.failed.map((f) => f.label + '（' + f.value + '，要求 ' + f.threshold + '）').join('；'),
      );
    }
    return lines.join('\n');
  }).join('\n');
}

function describeCondition(c: Condition): string {
  if (c.rightParam) return c.left.name + ' ' + c.op + ' ' + c.rightParam;
  return c.left.name + ' ' + c.op + ' ' + c.right.name;
}

/**
 * 把模型那份 JSON 收敛成能跑的假设。
 *
 * 这段是整个 AI 层唯一的守门人：模型说什么不重要，能通过这里才算数。
 * 任何一项不合格就整个退回默认假设 —— 不"尽量修补"，因为一个悄悄改过的假设
 * 回测出来的结论，和模型原本想测的东西已经不是一回事了。
 */
/**
 * 从参数名推断它是哪个指标。
 *
 * 模型写 entry 时只给参数名（"fast"、"slow"），而引擎要的是"哪个指标 + 哪个周期键"。
 * 约定是参数名自己带指标线索：
 *   ema5 / emaFast / ema_20  → ema
 *   rsi / rsiPeriod / rsiP   → rsi
 *   atrPeriod                → atr
 *   n / lookback / period    → highest 或 lowest（看条件里拿它跟什么比）
 * 推断不出来时退回 close —— 会读成"拿收盘价跟它比"，多数情况不成立，
 * 于是这条假设跑出来没有交易，用户能看见"假设无效"，而不是悄悄算了一版错的。
 */
/** 认指标时用的规范名：列表里的原名 + 它的全小写 */
const INDICATOR_IDS: { canonical: string; lower: string }[] = [
  { canonical: 'ema', lower: 'ema' },
  { canonical: 'sma', lower: 'sma' },
  { canonical: 'rsi', lower: 'rsi' },
  { canonical: 'atr', lower: 'atr' },
  { canonical: 'highest', lower: 'highest' },
  { canonical: 'lowest', lower: 'lowest' },
  { canonical: 'volumeSma', lower: 'volumesma' },
  { canonical: 'swingHigh', lower: 'swinghigh' },
  { canonical: 'swingLow', lower: 'swinglow' },
];

function inferIndicator(name: string, hint?: 'high' | 'low', paramKeys: string[] = []): IndicatorRef {
  const s = name.toLowerCase();

  // 1) 参数名本身就是个指标名（"rsi"、"ema"、"atr"）。
  //    周期可能在别的键上（rsiPeriod / emaP），找一个像周期的搭进去；
  //    找不到就用默认的 "period"（indicators.ts 里有默认值），而不是用它自己 ——
  //    用它自己会拿到 undefined，指标算出来是空的。
  const selfHit = INDICATOR_IDS.find((d) => d.lower === s);
  if (selfHit) {
    const partner = paramKeys
      .filter((k) => k.toLowerCase() !== s && k.toLowerCase().startsWith(s))
      .sort((a, b) => a.length - b.length)
      // 以 period / length / len 结尾，或者干脆只有一个字母（rsiP）
      .find((k) => /(period|length|len)$/i.test(k) || k.slice(s.length).length === 1);
    return { name: selfHit.canonical, periodKey: partner ?? 'period' };
  }

  // 1.5) 名字里带指标词但不是以它开头（trendPeriod、myRsiLen）：指标是那个词，周期键是它自己。
  //      比 "以…开头" 宽一档，因为模型常写 trendPeriod / shortMa 这种。
  const contains = INDICATOR_IDS
    .slice()
    .sort((a, b) => b.lower.length - a.lower.length)
    .find((d) => s.includes(d.lower) && d.lower.length >= 3);
  if (contains) return { name: contains.canonical, periodKey: name };

  // 2) 参数名以指标名开头（emaFast、rsiShort、atrSlow）：指标就是它，周期键是它自己。
  //    这里必须用"以…开头"，不能用"包含"：name 里包含 "p" 这种字母的组合太多了，
  //    用包含会把 "stopMult" 认成 sma。
  const prefixHit = INDICATOR_IDS
    .sort((a, b) => b.lower.length - a.lower.length) // 长的优先，volumesma 先于 sma
    .find((d) => s.startsWith(d.lower));
  if (prefixHit) return { name: prefixHit.canonical, periodKey: name };
  // 4) 带"趋势/均线"意味的词：trendPeriod、maPeriod、avgLen、basisPeriod
  //    这些在模型嘴里就是"一条均线"，认成 EMA 最接近它的本意。
  //    这一条必须在 close 兜底之前 —— 否则 trendPeriod 会退化成"收盘价跟一个数字比"，
  //    那个条件没有意义，回测跑出来一堆交易，测的不是它说的东西。
  if (/(trend|basis|average|smooth)/.test(s)) return { name: 'ema', periodKey: name };
  if (/^(ma|avg)/.test(s)) return { name: 'ema', periodKey: name };
  if (/^(vol|volume)/.test(s)) return { name: 'volumeSma', periodKey: name };
  if (/^(n|lookback|window|bars|period|len|length)$/.test(s)) {
    if (hint === 'high') return { name: 'highest', periodKey: name };
    if (hint === 'low') return { name: 'lowest', periodKey: name };
    return { name: 'ema', periodKey: name }; // 交叉类默认当均线用
  }
  if (/^(th|threshold|level|limit|trigger)/.test(s)) return { name: 'close', periodKey: name };
  return { name: 'close', periodKey: name };
}

export function sanitizeHypothesis(raw: unknown, fallback: Hypothesis): Hypothesis {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: Hypothesis = { ...fallback, entry: [...fallback.entry] };

  const thesis = typeof o.thesis === 'string' && o.thesis.trim() ? o.thesis.trim().slice(0, 200) : '';
  if (thesis) out.thesis = thesis;
  out.side = o.side === 'short' ? 'short' : 'long';

  // ---- 参数 ----
  // 两种形态都收：
  //   { params: { fast: 10 } }                     ← 现在是这种（指标靠参数名在 entry 里指）
  //   { indicators: { fast: { indicator, period } } } ← 旧形态，留着兼容
  const params: Params = {};
  const refs = new Map<string, IndicatorRef>();
  let bad = false;

  const rawParams = (o.params ?? {}) as Record<string, unknown>;
  for (const [key, val] of Object.entries(rawParams)) {
    const n = Number(val);
    if (!Number.isFinite(n) || n < PERIOD_MIN || n > PERIOD_MAX) { bad = true; break; }
    params[key] = Math.round(n);
  }

  const inds = (o.indicators ?? null) as Record<string, { indicator?: string; period?: number }> | null;
  if (!bad && inds && !Array.isArray(inds)) {
    for (const [key, spec] of Object.entries(inds)) {
      const name = String(spec?.indicator ?? '');
      if (!KNOWN_INDICATORS.has(name)) { bad = true; break; }
      const period = Number(spec?.period);
      if (!Number.isFinite(period) || period < PERIOD_MIN || period > PERIOD_MAX) { bad = true; break; }
      params[key] = Math.round(period);
      refs.set(key, { name, periodKey: key });
    }
  }
  if (bad) return fallback;

  // ---- 范围 ----
  const ranges: Record<string, [number, number, number]> = {};
  const rawRanges = (o.ranges ?? {}) as Record<string, unknown>;
  let combos = 1;
  for (const [key, val] of Object.entries(rawRanges)) {
    if (!(key in params)) continue; // 范围指向一个不存在的参数：忽略，别让它把整个假设拖垮
    if (!Array.isArray(val) || val.length < 3) continue;
    // noUncheckedIndexedAccess 下解构出来是 number | undefined，先显式取三个再看
    const min = Number(val[0]);
    const max = Number(val[1]);
    const step = Number(val[2]);
    if (![min, max, step].every((n) => Number.isFinite(n))) continue;
    if (min < PERIOD_MIN || max > PERIOD_MAX || step <= 0 || max < min) continue;
    ranges[key] = [min, max, step];
    combos *= Math.floor((max - min) / step) + 1;
  }
  // 组合数超过 200 就缩步长：宁可搜得粗一点，也不要跑一次回测卡半分钟
  if (combos > 200) {
    for (const key of Object.keys(ranges)) {
      const [min, max, step] = ranges[key]!;
      ranges[key] = [min, max, Math.max(step, Math.ceil((max - min) / 20))];
    }
  }
  out.params = params;
  out.ranges = ranges;

  // ---- 入场条件 ----
  const entry: Condition[] = [];
  const rawEntry = Array.isArray(o.entry) ? o.entry : [];
  for (const item of rawEntry.slice(0, MAX_CONDITIONS)) {
    const c = item as { left?: string; op?: string; right?: string; rightConstant?: string };
    const leftName = String(c.left ?? '');
    // 提示方向：拿它跟"收盘价高于它"比，说明它多半是某个高点；低于它则是低点
    const highHint: 'high' | 'low' = c.op === '>' || c.op === '>=' ? 'high' : 'low';
    // 一律走 inferIndicator：它知道"参数名本身就是指标名"和"以指标名开头"这两种写法，
    // 也会把周期接到 rsiPeriod / emaFast 这些键上。以前这里先拦一道 KNOWN_INDICATORS，
    // 结果 "rsi" 被直接塞了个 periodKey: 'period'，和 params 里的 rsiPeriod 对不上。
    const left: IndicatorRef = leftName === 'close'
      ? { name: 'close' }
      : refs.get(leftName) ?? inferIndicator(leftName, c.op === '>' || c.op === '>=' ? 'high' : 'low', Object.keys(params));
    if (!left) { bad = true; break; }
    const op = String(c.op ?? '');
    if (!KNOWN_OPS.has(op)) { bad = true; break; }

    const cond: Condition = { left, op: op as Condition['op'], right: { name: 'close' } };
    // shift：模型用得上就带上（假突破、回踩这类形态全靠它）
    const shift = Number((c as { shift?: unknown }).shift);
    if (Number.isFinite(shift) && shift > 0) cond.shift = Math.min(10, Math.round(shift));
    const rightShift = Number((c as { rightShift?: unknown }).rightShift);
    if (Number.isFinite(rightShift) && rightShift > 0) cond.rightShift = Math.min(10, Math.round(rightShift));
    if (c.rightConstant && params[String(c.rightConstant)] !== undefined) {
      cond.rightParam = String(c.rightConstant);
    } else {
      const rightName = String(c.right ?? '');
      const right: IndicatorRef | null = rightName === 'close'
        ? { name: 'close' }
        : refs.get(rightName) ?? inferIndicator(rightName, c.op === '>' || c.op === '>=' ? 'low' : 'high', Object.keys(params));
      if (!right) { bad = true; break; }
      cond.right = right;
    }
    entry.push(cond);
  }
  if (bad || entry.length === 0) return fallback;
  out.entry = entry;

  // ---- 止损止盈 ----
  const stopKind = String((o.stop as { kind?: string })?.kind ?? 'atr');
  const stopVal = Number((o.stop as { value?: number })?.value);
  if ((stopKind === 'atr' || stopKind === 'pct') && Number.isFinite(stopVal) && stopVal > 0 && stopVal < 20) {
    out.stop = { kind: stopKind, value: stopVal };
  }
  const tgtKind = String((o.target as { kind?: string })?.kind ?? 'rr');
  const tgtVal = Number((o.target as { value?: number })?.value);
  if ((tgtKind === 'atr' || tgtKind === 'pct' || tgtKind === 'rr')
    && Number.isFinite(tgtVal) && tgtVal > 0 && tgtVal < 50) {
    out.target = { kind: tgtKind, value: tgtVal };
  }

  const validate = typeof o.whatToValidate === 'string' ? o.whatToValidate.trim().slice(0, 200) : '';
  if (validate) out.whatToValidate = validate;
  out.origin = fallback.origin === 'first' ? 'revise' : fallback.origin;

  // 止损止盈要用 ATR 时，params 里必须有 atrPeriod，否则预热和止损距离都会算错
  if (out.stop.kind === 'atr' || out.target.kind === 'atr') {
    if (out.params.atrPeriod === undefined) out.params.atrPeriod = 14;
  }
  return out;
}


/**
 * 语义校验：条件写出来能跑，不等于它表达的是那个意思。
 *
 * 这一层是实测逼出来的。模型提「假突破：跌破前低后收回」，写成了
 *   { left: close, op: '>', right: lowest }
 * 这个条件的意思是"收盘价高于前 N 根最低"，几乎每根 K 线都成立 ——
 * 它描述的不是形态，而是"价格在前低之上"，等于没有条件。回测跑出来一堆交易，
 * 结论看着像模像样，实际测的根本不是模型想的东西。
 *
 * 所以这里做两件事：
 *   1. 找出"恒真/恒假"的条件，直接判为无效假设。
 *   2. 假设的文字描述里提到形态词（假突破、回踩、收回、跌破后……），
 *      但条件里没有任何跨根比较（shift / crossUp / crossDown）时，
 *      判定为"表达不了这个形态"，让模型重写，而不是硬跑一个错的。
 *
 * 判为无效时不抛异常、也不静默修补：返回原因，上层决定是让模型重提还是停。
 */

export interface SemanticIssue {
  code: 'always_true' | 'always_false' | 'shape_not_expressible' | 'no_condition' | 'same_side_both_directions';
  message: string;
  /** 给模型的修正提示，下一轮直接拼进提示词 */
  hint: string;
}

/** 描述里出现这些词，说明想表达的是"跨根才能认出来的形态" */
const SHAPE_WORDS = /(假突破|回踩|收回|重新站上|跌破后|突破后回落|二次|确认|反包|吞没|触发)/;
/** 跨根表达：shift 或者穿越类算子 */
function hasCrossBar(c: Condition): boolean {
  return (c.shift ?? 0) > 0 || (c.rightShift ?? 0) > 0 || c.op === 'crossUp' || c.op === 'crossDown';
}

/** 粗略判断条件是不是恒真：左边和右边是同一个指标同一个周期，算子又如实了之 */
function isTriviallyTrue(c: Condition): boolean {
  if (c.rightParam) return false;
  if (hasCrossBar(c)) return false;
  // 注意比的是 name 而不是 periodKey：close 和 close 不管周期键怎么写都是同一个东西，
  // 拿它跟自己比必然恒定成立。以前只比了 name+periodKey，模型写
  // "{left:'close', right:'close'}" 时两个 periodKey 都默认 'period'，能拦住；
  // 但一旦它写了 right: "trendPeriod"（被识别成 close），就漏过去了。
  // 所以这里只认指标名。
  const same = c.left.name === c.right.name;
  return same && (c.op === '>=' || c.op === '<=' || c.op === '>' || c.op === '<');
}

/**
 * 检查一个假设是不是真的表达了它自己说的东西。
 * `prices` 是这一段的收盘价，用来实测"这个条件是不是几乎永远成立"。
 */
export function validateSemantics(
  h: { thesis: string; entry: Condition[] },
  prices: number[],
  evaluate: (c: Condition, i: number) => boolean,
): SemanticIssue[] {
  const issues: SemanticIssue[] = [];

  if (h.entry.length === 0) {
    issues.push({
      code: 'no_condition',
      message: '没有任何入场条件',
      hint: '至少给一条入场条件',
    });
    return issues;
  }

  for (const c of h.entry) {
    if (isTriviallyTrue(c)) {
      issues.push({
        code: 'always_true',
        message: '条件 ' + describe(c) + ' 左右是同一个指标同一个周期，永远成立',
        hint: '换成两个不同的指标，或者加 shift 比较相邻两根',
      });
    }
  }

  /**
   * 实测触发率。单个条件在整段数据上触发超过 90%，基本等于"没筛掉任何东西"；
   * 低于 0.5% 则几乎不成交，回测样本会少到没法判定。两头都要报。
   * 只在至少有 100 个点的时候统计，太短的段没意义。
   */
  if (prices.length >= 100) {
    const start = Math.min(50, Math.floor(prices.length / 4));

    /**
     * 看的是**整组条件的触发率**，不是每一条各自的触发率。
     *
     * 这一条是被测试打出来的：假突破的正确写法是
     *   "上一根收盘 < 前低" 且 "当根收盘 > 前低"
     * 单看第一条只有 0% 成立、单看第二条 100% 成立，逐条统计会把正确写法判成无效。
     * 但两条放一起，它才是一个真正的形态。条件是 AND 关系，就该按 AND 之后的频率来判断。
     */
    let hit = 0;
    let total = 0;
    for (let i = start; i < prices.length; i++) {
      total += 1;
      if (h.entry.every((c) => evaluate(c, i))) hit += 1;
    }
    if (total > 0) {
      const rate = hit / total;
      if (rate >= 0.9) {
        issues.push({
          code: 'always_true',
          message: '整组条件在 ' + (rate * 100).toFixed(1) + '% 的 K 线上都成立，等于没有筛选',
          hint: '这组条件太宽松，几乎每根 K 线都满足。收紧阈值，或者换能区分行情的条件',
        });
      } else if (rate < 0.002) {
        issues.push({
          code: 'always_false',
          message: '整组条件只在 ' + (rate * 100).toFixed(2) + '% 的 K 线上成立，几乎没有样本',
          hint: '条件太苛刻，回测凑不出交易。去掉其中一条或者放宽阈值',
        });
      }
    }
  }

  // 说了形态却没写跨根比较：表达不了
  if (SHAPE_WORDS.test(h.thesis) && !h.entry.some(hasCrossBar)) {
    issues.push({
      code: 'shape_not_expressible',
      message: '假设说的是「' + h.thesis.slice(0, 30) + '…」这类形态，但条件里没有任何跨根比较',
      hint: '形态要用 shift 表达。比如"跌破前低后又收回"要写成两条条件：'
        + '{left:"close", op:"<", right:"lowest"} 且 {left:"close", shift:1, op:"<", right:"lowest", rightShift:1} '
        + '再加 {left:"close", op:">", right:"lowest"}',
    });
  }

  return issues;
}

function describe(c: Condition): string {
  const l = c.left.name + (c.shift ? '[t-' + c.shift + ']' : '');
  const r = c.rightParam ?? (c.right.name + (c.rightShift ? '[t-' + c.rightShift + ']' : ''));
  return l + ' ' + c.op + ' ' + r;
}

/**
 * 检查模型的回包结构对不对，返回问题清单（空数组表示合格）。
 *
 * 只查"能不能被 sanitize 吃下去"这一层，不管数值合理性 —— 那是 sanitize 的活。
 * 分开的原因是：结构问题可以让模型立刻重写一次，数值问题重写也没用，
 * 说明它没看懂材料，退回兜底更省事。
 */
export function schemaProblems(j: Record<string, unknown> | null): string[] {
  if (!j) return ['没有解析出 JSON 对象'];
  const out: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(j, k);
  if (!has('side')) out.push('缺 side');
  if (!has('params') && !has('indicators')) out.push('缺 params（参数对象）');
  if (!has('entry')) out.push('缺 entry');
  if (has('entry') && !Array.isArray(j.entry)) out.push('entry 必须是数组，不是 ' + typeof j.entry);
  if (Array.isArray(j.entry)) {
    for (const [i, c] of (j.entry as unknown[]).entries()) {
      const o = (c ?? {}) as Record<string, unknown>;
      if (typeof o !== 'object' || Array.isArray(o)) { out.push('entry[' + i + '] 必须是对象'); continue; }
      if (!o.left) out.push('entry[' + i + '] 缺 left');
      if (!o.op) out.push('entry[' + i + '] 缺 op');
      if (!o.right && !o.rightConstant) out.push('entry[' + i + '] 缺 right');
    }
  }
  // 模型爱用的那几套字段：出现了就说明它没按结构来
  for (const wrong of ['hypothesis', 'indicators', 'exit', 'parameters', 'validation', 'risks']) {
    if (has(wrong)) out.push('多了不允许的字段 ' + wrong);
  }
  return out;
}

/** 第一轮的兜底假设：突破前高。不算好，但结构完整、能跑 */
export const FALLBACK_HYPOTHESIS: Hypothesis = {
  thesis: '价格突破前 N 根高点后延续，用 ATR 止损、盈亏比 2 止盈',
  side: 'long',
  params: { n: 20, atrPeriod: 14 },
  ranges: { n: [10, 60, 10] },
  entry: [{ left: { name: 'close' }, op: '>', right: { name: 'highest', periodKey: 'n' } }],
  stop: { kind: 'atr', value: 1.5 },
  target: { kind: 'rr', value: 2 },
  whatToValidate: '突破之后是否真的能延续',
  origin: 'first',
};

/** 假设 → 引擎能吃的策略 */
export function toSpec(h: Hypothesis, name: string): StrategySpec {
  return {
    name,
    side: h.side,
    params: h.params,
    ranges: h.ranges,
    entry: h.entry,
    stop: h.stop,
    target: h.target,
    maxPositions: 1,
  };
}

export interface AskOpts {
  contract: string;
  interval: string;
  bars: number;
  days: number;
  gaps: number;
  rounds: RoundSummary[];
}

/**
 * 问模型要下一版假设。
 *
 * 失败时返回 FALLBACK_HYPOTHESIS 并把原因带出来 —— 一轮研究不该因为模型抽风而中断，
 * 但"这一版是兜底的、不是模型提的"必须让用户看见，否则会以为 AI 认真想过。
 */
export async function proposeHypothesis(
  opts: AskOpts,
): Promise<{ hypothesis: Hypothesis; error?: string; model?: string }> {
  const material = [
    '数据概况：',
    '  合约 ' + opts.contract + '，周期 ' + opts.interval,
    '  共 ' + opts.bars + ' 根 K 线，覆盖 ' + opts.days.toFixed(0) + ' 天' + (opts.gaps > 0 ? '，有 ' + opts.gaps + ' 处断档' : '，无断档'),
    '',
    '可用指标：',
    indicatorCatalogText(),
    '',
    '之前的尝试：',
    historyText(opts.rounds),
  ].join('\n');

  const fallback: Hypothesis = { ...FALLBACK_HYPOTHESIS, origin: opts.rounds.length ? 'revise' : 'first' };

  try {
    // 复用 ai.ts 的那条调用路径：它已经处理了中转站不认 response_format、
    // 推理模型把预算花在思考上、超时这些情况
    const { chatJson } = await import('../ai.js');
    const r = await chatJson({
      system: SYSTEM,
      user: material,
      maxTokens: 2000,
      timeoutMs: 90_000,
    });
    let parsed = r.json as Record<string, unknown> | null;
    // 结构校验：模型经常回它自己那套字段（entry 写成按方向分组、params 叫 parameters）。
    // 这种回包解析出来"像 JSON"但跑不起来。先检字段名，不合格就带着错误清单再要一次 ——
    // 实测一次重试能把大部分格式问题拉回来，比直接退兜底有用得多
    const missing = schemaProblems(parsed);
    if (missing.length > 0) {
      const retry = await chatJson({
        system: SYSTEM,
        user: material
          + '\n\n【上一版被退回的原因】\n你上一次的输出结构不对：' + missing.join('；')
          + '\n请严格按要求的字段重写，只输出 JSON。',
        maxTokens: 2000,
        timeoutMs: 90_000,
        retries: 1,
      });
      parsed = retry.json as Record<string, unknown> | null;
      if (schemaProblems(parsed).length > 0) {
        return {
          hypothesis: fallback,
          error: '模型两次都没按约定结构返回（' + schemaProblems(parsed).join('；') + '），这一轮用兜底假设',
          model: r.model,
        };
      }
    }
    const h = sanitizeHypothesis(parsed, fallback);
    // 退回兜底就说明模型给的东西没通过校验，要说出来
    const isFallback = JSON.stringify(h) === JSON.stringify(fallback);
    return {
      hypothesis: h,
      error: isFallback ? '模型给的假设没通过校验（指标名或参数范围不在允许范围内），这一轮用兜底假设' : undefined,
      model: r.model,
    };
  } catch (e) {
    const err = e as { label?: string; status?: number; message?: string };
    // 把"被限流"和"接口坏了"分开说：前者等一会儿再点一次就行，后者要查设置
    const why = err.label === 'AI_RATE_LIMIT' || err.status === 429
      ? '模型接口限流（429），这一轮没提成假设，等几十秒再试一次'
      : '问模型的这一步失败了：' + (err.message ?? String(e));
    return { hypothesis: fallback, error: why, model: config.ai.model };
  }
}