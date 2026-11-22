/**
 * 经典 K 线形态识别。
 *
 * 判定规则来自 vendor 进来的 cm45t3r/candlestick（MIT，见 ./candlestick/README.md），
 * 这里只做三件事，规则本身一行不改：
 *
 *   1. 趋势上下文：用库自带的 trendContext（SMA 斜率）给每个命中算 contextFit；
 *      上不上图按库的 strength 元数据来（见下面 passes()），不另设阈值。
 *   2. 一根 K 线只留一个形态：三根的优先于两根的，同长度取有效置信度高的。
 *   3. 分段增量扫描：补历史、来新 K 线、裁掉最老的一段，各自只重算受影响的那段。
 *      库整段扫 4000 根要 100~230ms，每 300 毫秒来一次是扛不住的。
 *
 * 十字星、纺锤线这类库标成 neutral 的形态仍然参与计算，但不往图上标 ——
 * 这一页回答的是「看涨还是看跌」，没有方向的不适合画成箭头。需要的话在 scanRange 里放开。
 *
 * 形态名映射是人工核过的：库对同一个形状会给出 hammer / bullishHammer / bearishHammer
 * 三个 id（方向都由 patternMetadata 给出），中文名合并成「锤子」，方向照库的元数据走。
 */
import type { Bar } from './api.ts';
import { firstIndexAtOrAfter } from './candles.ts';
import { allPatterns, patternChain } from './candlestick/patternChain.js';
import { getPatternMetadata } from './candlestick/patternMetadata.js';

export type PatternDirection = 'bull' | 'bear';

export interface PatternHit {
  /** 形态确认那根在 bars 里的下标 */
  index: number;
  time: number;
  /** 库里的形态 id（hammer / bullishEngulfing …） */
  id: string;
  /** 中文名，直接显示给人看 */
  name: string;
  direction: PatternDirection;
  /** 库给的有效置信度（confidence × contextFit）。只用于取舍，不显示 */
  fit: number;
}

/**
 * 中文名 + 这个形态用几根 K 线确认（优先级也按它排）。
 * 库的 id 一共 29 个，有的只是同一个形状的不同实体方向，中文名合并。
 */
const PATTERNS: Record<string, { name: string; span: 1 | 2 | 3 }> = {
  hammer: { name: '锤子', span: 1 },
  bullishHammer: { name: '锤子', span: 1 },
  bearishHammer: { name: '锤子', span: 1 },
  invertedHammer: { name: '倒锤', span: 1 },
  bullishInvertedHammer: { name: '倒锤', span: 1 },
  bearishInvertedHammer: { name: '倒锤', span: 1 },
  doji: { name: '十字星', span: 1 },
  marubozu: { name: '光头光脚', span: 1 },
  bullishMarubozu: { name: '光头光脚阳线', span: 1 },
  bearishMarubozu: { name: '光头光脚阴线', span: 1 },
  spinningTop: { name: '纺锤线', span: 1 },
  bullishSpinningTop: { name: '纺锤线', span: 1 },
  bearishSpinningTop: { name: '纺锤线', span: 1 },
  bullishEngulfing: { name: '看涨吞没', span: 2 },
  bearishEngulfing: { name: '看跌吞没', span: 2 },
  bullishHarami: { name: '看涨孕线', span: 2 },
  bearishHarami: { name: '看跌孕线', span: 2 },
  bullishKicker: { name: '看涨踢线', span: 2 },
  bearishKicker: { name: '看跌踢线', span: 2 },
  hangingMan: { name: '上吊线', span: 2 },
  shootingStar: { name: '流星', span: 2 },
  piercingLine: { name: '曙光初现', span: 2 },
  darkCloudCover: { name: '乌云盖顶', span: 2 },
  tweezersTop: { name: '镊子顶', span: 2 },
  tweezersBottom: { name: '镊子底', span: 2 },
  morningStar: { name: '早晨之星', span: 3 },
  eveningStar: { name: '黄昏之星', span: 3 },
  threeWhiteSoldiers: { name: '红三兵', span: 3 },
  threeBlackCrows: { name: '三只乌鸦', span: 3 },
};

/**
 * 上不上图，看库自己的元数据，不另设「置信度门槛」：
 *   - strong（吞没、踢线、星辰、三兵三鸦、光头光脚）：直接显示；
 *   - moderate（锤子、孕线、镊子…）：只在趋势对齐（contextFit ≥ 0.9）时显示；
 *   - weak / neutral（十字星、纺锤）：不显示。
 * 实测三个样本（BTC 1h / ETH 4h / DOGE 1d）密度 11.5%~15.8%，和之前的手感一致；
 * 不筛的话 4000 根里有 53% 的 K 线都能套上某个形态，图上会糊成一片。
 */
function passes(meta: { direction: string; strength: string }, fit: number): boolean {
  if (meta.direction === 'neutral') return false;
  if (meta.strength === 'strong') return true;
  if (meta.strength === 'moderate') return fit >= 0.9;
  return false;
}
/** 重算时往回多带几根：趋势上下文看 10 根，最长的形态用 3 根，再留点余量 */
const LOOKBACK = 32;
const TREND = {
  trendMethod: 'sma-slope' as const,
  trendPeriod: 10,
  /**
   * 不开 resolveConflicts。
   *
   * 它会在「两根重叠、方向相反」的形态里丢掉置信度低的那个 —— 这个判定是跨 K 线的：
   * 新来一根可能让前面已经标上的那根作废。增量扫描是按段重算的，开着它就永远对不上整段结果。
   * 本页一根 K 线只留一个形态，方向冲突在选的时候已经消化掉了，不需要它再删一遍。
   */
  resolveConflicts: false,
};

/**
 * 扫一段 K 线，只保留 [keepFrom, to) 的命中，返回每根最多一个形态。
 *
 * 趋势上下文要前 10 根，所以实际从 keepFrom - LOOKBACK 开始算，算完把前面的丢掉 ——
 * 不这么做的话，每段开头十几根都会因为「没有上下文」而按 0.5 处理，和整段扫描对不上。
 */
function scanRange(bars: Bar[], keepFrom: number, to: number): PatternHit[] {
  // 趋势上下文要看前 10 根：从 keepFrom 往前多取 LOOKBACK 根一起算，但只留下 keepFrom 之后的命中。
  const start = Math.max(0, keepFrom - LOOKBACK);
  const end = Math.min(bars.length, to);
  if (end - start <= 0) return [];
  const slice = bars.slice(start, end);
  const results = patternChain(slice, allPatterns, { trendContext: TREND });
  const best = new Map<number, PatternHit>();
  for (const result of results) {
    const info = PATTERNS[result.pattern];
    const meta = getPatternMetadata(result.pattern);
    if (!info || !meta) continue;
    const fit = (meta.confidence ?? 0) * (typeof result.contextFit === 'number' ? result.contextFit : 0.5);
    if (!passes(meta, typeof result.contextFit === 'number' ? result.contextFit : 0)) continue;
    /**
     * 库返回的 index 是形态的**起始**那根（两/三根形态的 match 也从前一根开始）。
     * 图上要标的是「确认那根」—— 吞没标在吞没成立的那根，而不是被吞的那根。
     */
    const matchEnd = result.index + info.span - 1;
    const index = start + matchEnd;
    if (index < keepFrom) continue;
    const bar = slice[matchEnd];
    if (!bar) continue;
    const hit: PatternHit = {
      index,
      time: bar.time,
      id: result.pattern,
      name: info.name,
      direction: meta.direction === 'bullish' ? 'bull' : 'bear',
      fit,
    };
    const current = best.get(index);
    if (!current) {
      best.set(index, hit);
      continue;
    }
    const currentSpan = PATTERNS[current.id]?.span ?? 1;
    if (info.span > currentSpan || (info.span === currentSpan && fit > current.fit)) best.set(index, hit);
  }
  return [...best.values()].sort((a, b) => a.index - b.index);
}

export interface PatternScan {
  /** 这一批结果算的是哪份 K 线。下一次拿引用比，没换就直接复用 */
  bars: Bar[];
  hits: PatternHit[];
}

/**
 * 增量扫描。
 *
 * 实盘里数据只会以四种方式变，各自只重算一段：
 *   - 补历史（左边插进来一段）：旧结果整体后移，只重算新头部的 LOOKBACK 根；
 *   - 来新 K 线 / 只动最后一根：只重算尾部；
 *   - 到上限裁掉最老的一段：按时间保留旧结果，重算头部和尾部；
 *   - 其它（换周期、换数据源）：整段重算。
 *
 * 只重算受影响的段，是因为库整段扫 4000 根要 100~230ms，跟着 300ms 的行情刷新跑不起。
 */
/** 两根 K 线的内容和时间都一样（只在判断「这段变了没有」时用，不比较对象身份） */
function sameBar(a: Bar, b: Bar): boolean {
  return a.time === b.time && a.open === b.open && a.high === b.high
    && a.low === b.low && a.close === b.close;
}

/** 整段内容一致（REST 快照重建了对象，但数据没变） */
function sameSeries(a: Bar[], b: Bar[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!sameBar(a[i]!, b[i]!)) return false;
  return true;
}

export function scanPatterns(previous: PatternScan | null, bars: Bar[]): PatternScan {
  if (previous && previous.bars === bars) return previous;
  if (!previous) return { bars, hits: scanRange(bars, 0, bars.length) };


  const old = previous.bars;
  const oldLen = old.length;
  const newLen = bars.length;
  if (oldLen === 0) return { bars, hits: scanRange(bars, 0, newLen) };
  const minLen = Math.min(oldLen, newLen);

  let prefix = 0;
  while (prefix < minLen && old[prefix] === bars[prefix]) prefix += 1;
  /**
   * 整段内容没变、只是换了一批对象（REST 快照重建数组）：结果原样复用。
   * 放在身份比较之后、且只在前缀为 0 时才做 —— 正常尾部更新前缀会直接停在其一处，
   * 不会每帧白扫两万根。
   */
  if (prefix === 0 && sameSeries(old, bars)) return { bars, hits: previous.hits };
  /**
   * 身份一个都对不上、但内容其实连续（比如整页都是新对象 + 尾部多了一根）：
   * 按内容再找一遍前缀。
   */
  if (prefix === 0 && oldLen > 0) {
    while (prefix < minLen && sameBar(old[prefix]!, bars[prefix]!)) prefix += 1;
  }
  if (prefix === minLen && oldLen === newLen) return { bars, hits: previous.hits };
  let suffix = 0;
  while (suffix < minLen - prefix && old[oldLen - 1 - suffix] === bars[newLen - 1 - suffix]) suffix += 1;
  if (suffix === 0 && prefix < minLen) {
    while (suffix < minLen - prefix && sameBar(old[oldLen - 1 - suffix]!, bars[newLen - 1 - suffix]!)) suffix += 1;
  }

  // 1) 纯头部插入：旧数据整个是新数据的后缀
  if (prefix === 0 && suffix >= oldLen - 1 && newLen > oldLen) {
    const shift = newLen - oldLen;
    const headEnd = Math.min(newLen, shift + LOOKBACK);
    const head = scanRange(bars, 0, headEnd);
    const shifted = previous.hits.map((h) => ({ ...h, index: h.index + shift }));
    return { bars, hits: [...head, ...shifted.filter((h) => h.index >= headEnd)] };
  }

  // 2) 尾部追加 / 只动最后几根：旧数据是新数据的前缀
  if (prefix >= oldLen - 2) {
    const tail = scanRange(bars, prefix, newLen);
    return { bars, hits: [...previous.hits.filter((h) => h.index < prefix), ...tail] };
  }

  // 3) 头部被裁掉（到上限了）：按时间找回旧结果，头部和尾部各重算一次
  const anchor = old.indexOf(bars[0]!);
  if (anchor >= 0) {
    let aligned = true;
    for (let i = 0; i < oldLen - anchor; i += 1) {
      if (old[anchor + i] !== bars[i]) { aligned = false; break; }
    }
    if (aligned) {
      const firstTime = bars[0]!.time;
      const kept = previous.hits
        .filter((h) => h.time >= firstTime)
        .map((h) => ({ ...h, index: firstIndexAtOrAfter(bars, h.time) }))
        .filter((h) => bars[h.index]?.time === h.time);
      const alignedLen = oldLen - anchor;
      const headEnd = Math.min(newLen, LOOKBACK);
      return {
        bars,
        hits: [
          ...scanRange(bars, 0, headEnd),
          ...kept.filter((h) => h.index >= headEnd && h.index < alignedLen),
          ...scanRange(bars, Math.max(headEnd, alignedLen), newLen),
        ],
      };
    }
  }

  // 4) 其它情况：整段重算
  return { bars, hits: scanRange(bars, 0, newLen) };
}

/**
 * 展示层的稀疏化：同一段里至少隔 MIN_GAP 根再标一个，挤在一起时留置信度高的那个。
 *
 * 5m 上库的「吞没」几乎每两根就出一次（SOL 5m 实测 45.8% 的 K 线都有命中），
 * 全画出来箭头比 K 线还多。稀疏化只改「画几个」，识别结果本身不动，
 * 所以增量扫描和整段重算仍然是逐条一致的（自检里也是拿未稀疏的结果比）。
 */
export const MIN_GAP = 3;
export function thinHits(hits: PatternHit[], gap = MIN_GAP): PatternHit[] {
  const out: PatternHit[] = [];
  for (const hit of hits) {
    const prev = out[out.length - 1];
    if (prev && hit.index - prev.index < gap) {
      if (hit.fit > prev.fit) out[out.length - 1] = hit;
      continue;
    }
    out.push(hit);
  }
  return out;
}

/** 一次算完。脚本、自检用 */
export function detectPatterns(bars: Bar[]): PatternHit[] {
  return scanPatterns(null, bars).hits;
}

/** 库里会被展示的形态 id（去掉 neutral 的），给 README 和自检对口径用 */
export const PATTERN_IDS: { id: string; name: string; span: 1 | 2 | 3 }[] =
  Object.entries(PATTERNS).map(([id, info]) => ({ id, ...info }));
