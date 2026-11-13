
/**
 * 提示词策略的回测。
 *
 * 和规则策略的区别只在「这一根要不要开仓、开哪边」的来源：
 * 规则策略由条件算，这里由模型答。引擎、手续费、判定完全一样。
 *
 * 三个必须做到的约束，缺一条这个回测就没有意义：
 *   1. 上下文匿名化（buildAnonContext + assertAnonymous）
 *   2. 每根只看得到自己（引擎结构上不给后面的数据）
 *   3. 调用次数要有上限 —— 9000 根每根问一次模型是不可承受的，
 *      所以按 step 抽样：每 N 根问一次，中间沿用上一次的判断。
 */

import type { Candle } from './backtest.js';
import { buildAnonContext, assertAnonymous, parseVerdict, type Verdict, type PromptSignal } from './promptStrategy.js';

export interface PromptRunOpts {
  prompt: string;
  /** 每隔几根问一次模型。1 = 每根都问（很贵），10 = 每十根问一次 */
  step: number;
  /** 从第几根开始问（前面留给窗口预热） */
  startIndex: number;
  /** 最多问多少次。到上限就停，剩下的沿用最后一次判断 */
  maxCalls: number;
  /** 上下文窗口多少根 */
  lookback: number;
  /** 匿名化时要检查的禁用词（币种名、交易所名） */
  forbidden: string[];
  /** 问模型。返回它的原话 */
  ask: (system: string, user: string) => Promise<string>;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export interface PromptRunResult {
  signals: PromptSignal[];
  /** 问了多少次，其中多少次没解析出方向（记为 flat） */
  calls: number;
  flatFallbacks: number;
  /** 匿名化检查失败的次数。>0 说明有东西漏了，这份结果不能用 */
  leaks: number;
  cancelled: boolean;
}

export async function runPromptSignals(candles: Candle[], opts: PromptRunOpts): Promise<PromptRunResult> {
  const signals: PromptSignal[] = [];
  let calls = 0;
  let flatFallbacks = 0;
  let leaks = 0;
  let cancelled = false;

  // 要问的根号：从 startIndex 开始，每 step 根一次
  const targets: number[] = [];
  for (let i = opts.startIndex; i < candles.length; i += Math.max(1, opts.step)) targets.push(i);
  const total = Math.min(targets.length, opts.maxCalls);

  for (let k = 0; k < total; k++) {
    if (opts.isCancelled?.()) { cancelled = true; break; }
    const idx = targets[k]!;
    const ctx = buildAnonContext(candles, idx, opts.lookback);

    // 先确认没夹带身份信息，再发。发出去再发现就晚了 —— 那段上下文已经进了模型的上下文
    try {
      assertAnonymous(ctx.text + String.fromCharCode(10) + opts.prompt, opts.forbidden);
    } catch {
      leaks += 1;
      continue;
    }

    let raw = '';
    try {
      raw = await opts.ask(opts.prompt, ctx.text);
    } catch {
      // 单次调用失败不断整个回测：这一根当平，继续下一根
      flatFallbacks += 1;
      signals.push({ index: idx, side: 'flat', raw: '', confidence: null });
      calls += 1;
      continue;
    }

    const v = parseVerdict(raw);
    if (v.side === 'flat' && !/flat/i.test(raw)) flatFallbacks += 1;
    signals.push({ index: idx, side: v.side, raw: raw.slice(0, 300), confidence: v.confidence });
    calls += 1;
    opts.onProgress?.(calls, total);
  }

  return { signals, calls, flatFallbacks, leaks, cancelled };
}

/**
 * 把模型信号换成「每根一个方向」的数组，供引擎按外部信号成交。
 *
 * 两次提问之间的那几根沿用上一次的判断 —— 这是有意的：
 * 模型给的是「接下来往哪边走」，不是「下一根的价格」，中间不给新信息就不该凭空改主意。
 * 第一根提问之前的区间是 flat（空仓）。
 */
export function expandSignals(candles: Candle[], signals: PromptSignal[]): Verdict[] {
  const out: Verdict[] = new Array(candles.length).fill('flat');
  if (signals.length === 0) return out;
  let cur: Verdict = 'flat';
  let si = 0;
  for (let i = 0; i < candles.length; i++) {
    while (si < signals.length && signals[si]!.index <= i) {
      cur = signals[si]!.side;
      si += 1;
    }
    out[i] = cur;
  }
  return out;
}

/**
 * 对照基线：同一段数据上「随机入场」，用同样的持仓规则。
 *
 * 为什么必须有它：模型胜率 52% 看起来不错，但如果在同一段数据上无脑随机做多也是 52%，
 * 那这个 52% 什么也没说明。判定里要求提示词策略必须超过随机基线。
 */
export function randomBaselineSignals(candles: Candle[], step: number, startIndex: number, seed = 7): Verdict[] {
  const out: Verdict[] = new Array(candles.length).fill('flat');
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  let cur: Verdict = 'flat';
  for (let i = 0; i < candles.length; i++) {
    if (i >= startIndex && (i - startIndex) % Math.max(1, step) === 0) {
      const r = rnd();
      cur = r < 0.45 ? 'long' : r < 0.9 ? 'short' : 'flat';
    }
    out[i] = cur;
  }
  return out;
}
