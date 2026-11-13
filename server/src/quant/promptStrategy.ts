
/**
 * 提示词策略：用户写一段指令，模型读行情后给方向。
 *
 * 这一层的难点不是「怎么问模型」，是**怎么让回测结果有意义**。
 * 有一个做过严格实验的项目给出了直接答案（dsjwong/stockagent-backtester）：
 *
 *   给模型真实代码和日期，2022 年它避开科技股、押注能源，做到 +11.9%；
 *   把代码换成 Stock 07、日期换成 Day t、价格归一化到 100，同一个模型、
 *   同一段行情，只剩 +1.6%。同一天问 8 次：真实模式下 8/8 次全空仓；
 *   匿名化后 8/8 次满仓、每次都挑同样的四只。
 *
 *   它的结论是：任何在真实代码和日期上跑的 LLM 回测都是被污染的。
 *   无未来函数的引擎证明不了什么 —— 泄漏在模型权重里，不在提示词里。
 *
 * 所以这里的做法照抄那个控制实验：
 *   1. 匿名化：币种名、交易所、真实日期全不出现。价格归一化到 100。
 *   2. 不给未来：上下文只到当前根为止（引擎结构上不给后面的数据）。
 *   3. 可复现：温度 0，同一条提示词同一段上下文问两次结果要一致。
 *   4. 对照基线：跑完要和「同数据上的随机入场」比，跑不过随机的不算达标。
 *
 * 代价必须说清楚：匿名化之后模型拿不到它可能「记得」的东西，也可能因此变笨。
 * 这是有意的 —— 宁可要一个诚实的低分，也不要一个来自记忆的高分。
 */

import type { Candle } from './backtest.js';

/** 一次信号：这一根收盘后，模型怎么看下一根 */
export type Verdict = 'long' | 'short' | 'flat';

export interface PromptSignal {
  index: number;
  side: Verdict;
  raw: string;
  confidence: number | null;
}

export interface AnonContext {
  text: string;
  alias: string;
  basePrice: number;
}

const NL = String.fromCharCode(10);

/**
 * 把行情匿名化后再给模型看。
 *
 * 这里做的每一件事都对着一种具体的泄漏：
 *   · 换掉币种名 → 否则模型会调用「这个币在 2022 年发生过什么」的记忆
 *   · 换掉时间 → 否则它知道这段行情后面是什么
 *   · 价格归一化到 100 → 否则 60000 这个数字本身就暴露了币种和时间
 */
export interface AnonZone {
  center: number;
  low: number;
  high: number;
  type: 'support' | 'resistance';
  pTouch: number | null;
  pHold: number | null;
}

export function buildAnonContext(
  candles: Candle[],
  upTo: number,
  lookback = 40,
  /** 这一根上算出来的关键位。价格会跟着一起归一化，不泄露绝对价位 */
  zones: AnonZone[] = [],
): AnonContext {
  const from = Math.max(0, upTo - lookback + 1);
  const window = candles.slice(from, upTo + 1);
  const base = window[0]?.c ?? 0;
  const rows: string[] = [];
  const norm = (x: number) => (base > 0 ? (x / base) * 100 : 0);
  for (let i = 0; i < window.length; i++) {
    const c = window[i]!;
    rows.push(
      'Bar ' + (i - window.length + 1)
      + ' O=' + norm(c.o).toFixed(3)
      + ' H=' + norm(c.h).toFixed(3)
      + ' L=' + norm(c.l).toFixed(3)
      + ' C=' + norm(c.c).toFixed(3),
    );
  }

  const closes = window.map((c) => c.c);
  const last = closes[closes.length - 1] ?? 0;
  const first = closes[0] ?? 0;
  const ret = first > 0 ? ((last - first) / first) * 100 : 0;
  const hi = Math.max(...window.map((c) => c.h));
  const lo = Math.min(...window.map((c) => c.l));
  const posInRange = hi > lo ? ((last - lo) / (hi - lo)) * 100 : 50;

  const zoneLines = zones.slice(0, 6).map((zon) => {
    const tag = zon.type === 'support' ? '支撑' : '阻力';
    const touch = zon.pTouch === null ? '—' : (zon.pTouch * 100).toFixed(0) + '%';
    const hold = zon.pHold === null ? '—' : (zon.pHold * 100).toFixed(0) + '%';
    return '- ' + tag + ' 区间 ' + norm(zon.low).toFixed(3) + '~' + norm(zon.high).toFixed(3)
      + '（中心 ' + norm(zon.center).toFixed(3) + '），触达概率 ' + touch + '，守住概率 ' + hold;
  });

  const text = [
    '你是一个交易策略的执行者。下面是一段被匿名化的行情：',
    '- 标的代号 ASSET，品种和交易所都已被隐去，价格以窗口第一根收盘价归一化为 100。',
    '- 时间是相对序号：Bar 0 是最早一根，Bar -1 是最后一根（当前根）。',
    '',
    ...rows,
    '',
    ...(zoneLines.length > 0
      ? ['', '关键位（同样已归一化）：', ...zoneLines]
      : []),
    '',
    '窗口统计：',
    '- 区间涨跌：' + ret.toFixed(2) + '%',
    '- 现价在区间内的位置：' + posInRange.toFixed(1) + '%（0 = 最低，100 = 最高）',
    '',
    '根据上面的价格行为，判断下一根更可能往哪边走。',
    '只输出一个 JSON 对象，不要任何额外文字：',
    '{"side":"long"} 或 {"side":"short"} 或 {"side":"flat"}，可选加 "confidence": 0~1 和 "reason":"一句话"',
    '含义：long = 做多，short = 做空，flat = 不做。看不出来就给 flat。',
  ].join(NL);

  return { text, alias: 'ASSET', basePrice: base };
}

/**
 * 检查一段要给模型的文本里有没有夹带身份信息。
 *
 * 这是防线的最后一道：匿名化是「我们主动抹掉」，这里是「确认真的抹掉了」。
 * 一个写漏的字段就能把整段回测作废，而这种错误不会报错 —— 它只会让结果好看。
 */
export function assertAnonymous(text: string, forbidden: string[]): void {
  const upper = text.toUpperCase();
  const hits: string[] = [];
  for (const t of forbidden) {
    const token = t.toUpperCase();
    if (token.length >= 2 && upper.includes(token)) hits.push(t);
  }
  // 四位年份：真实日期会以 2021、2022 这种形式漏出来
  const years = text.match(/(?:19|20)[0-9]{2}/g);
  if (years) hits.push('年份 ' + Array.from(new Set(years)).join(','));
  if (hits.length > 0) {
    throw new Error('匿名化没做干净，上下文里出现了：' + hits.join(',') + ' —— 这段回测会被污染，拒绝执行');
  }
}

/**
 * 从模型回包里取方向。
 *
 * 模型不一定守格式：可能回 LONG、可能包在 markdown 里、可能多说一句。
 * 这里逐级退让，最后退到 flat —— 宁可少做一笔，也不要把「没看懂」当成「做多」。
 */
export function parseVerdict(text: string): { side: Verdict; confidence: number | null } {
  const t = String(text ?? '').trim();
  if (!t) return { side: 'flat', confidence: null };

  const tryJson = (raw: string): { side: Verdict; confidence: number | null } | null => {
    try {
      const o = JSON.parse(raw) as { side?: unknown; confidence?: unknown };
      const s = String(o.side ?? '').toLowerCase();
      if (s === 'long' || s === 'short' || s === 'flat') {
        const c = Number(o.confidence);
        return { side: s, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null };
      }
    } catch { /* 不是 JSON，往下走 */ }
    return null;
  };

  const direct = tryJson(t);
  if (direct) return direct;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) {
    const v = tryJson(fence[1].trim());
    if (v) return v;
  }

  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const v = tryJson(t.slice(a, b + 1));
    if (v) return v;
  }

  const lower = t.toLowerCase();
  if (/\bshort\b/.test(lower) && !/\blong\b/.test(lower)) return { side: 'short', confidence: null };
  if (/\blong\b/.test(lower) && !/\bshort\b/.test(lower)) return { side: 'long', confidence: null };

  return { side: 'flat', confidence: null };
}

export function signalsToMap(signals: PromptSignal[]): Map<number, PromptSignal> {
  const m = new Map<number, PromptSignal>();
  for (const s of signals) m.set(s.index, s);
  return m;
}
