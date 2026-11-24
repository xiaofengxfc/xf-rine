/**
 * 经典 K 线形态识别。
 *
 * 判定规则来自 vendor 进来的 cm45t3r/candlestick（MIT，见 ./candlestick/README.md），
 * 规则本身一行不改。外面这层做四件事：
 *
 *   1. 趋势上下文：用库自带的 trendContext（SMA 斜率）给每个命中算 contextFit，
 *      灵敏度按周期标定（patternStats.ts 里的 TREND_SENSITIVITY）。
 *      库的公式是 0.5 + 灵敏度 × 斜率，而斜率是「SMA 单根涨跌百分比」—— 量纲随周期变。
 *      写死默认的 5 时实测：5m 上中位数只有 0.50（几乎全拒），1h/1d 上直接饱和到 1.0
 *      （门槛形同不设）。标定之后 0.9 表示「本周期内前 25% 的趋势对齐度」。
 *
 *   2. 图上标的是「位置」，颜色和朝向用的是教科书的说法，不是统计结论。
 *      库自己在 patternMetadata 里写明 confidence 是「与上下文无关的固定值、已废弃」。
 *      实测（70456 根，BTC/ETH/DOGE/SOL × 5m~1d）比这更难看：25 个形态里没有一个在
 *      BH 校正后（FDR 10%）有正向方向增量，最显著的几个还是负的 —— 看涨吞没 z=−4.42、
 *      看跌吞没 z=−4.10、光头光脚阳线 z=−3.13。涨跌两侧一起偏，说明这是所有反转类形态
 *      共同的毛病（反转的反面就是趋势延续），不是某一个形态的参数问题。
 *
 *      处理方式分两层：
 *        · 位置照标 —— 「这里出现过吞没」是事实；「吞没＝看涨」是数据不支持的结论，
 *          所以箭头只复述教科书的归类。图上曾经只用中性色圆点，现在按产品要求改成
 *          绿↑ / 红↓，形状和颜色两样都在替书说话 —— 读数里的实测胜率/基准才是能不能当真的依据。
 *        · 统计数字（历史正确率 / 同方向基准 / 样本数）放进角标和图下列表，谁都能自己判断。
 *
 *      为什么不干脆按门槛把标记全关掉：那样这个开关就是个死功能（实测一个都不剩）。
 *      位置本身有信息 —— 想找「吞没出现的位置」看盘的人还需要它。
 *
 *   3. 一根 K 线只留一个形态：三根的优先于两根的，同长度取统计档位高的，再取方向增量更好的，
 *      最后才看库给的有效置信度。
 *
 *   4. 分段增量扫描：补历史、来新 K 线、裁掉最老的一段，各自只重算受影响的那段。
 *      库整段扫 4000 根要 100~230ms，每 300 毫秒来一次是扛不住的。
 *
 * 十字星、纺锤线这类库标成 neutral 的形态仍然参与计算，但不往图上标 —— 这一页回答的是
 * 「这根是什么」，没有方向的形态在列表里没法写方向，先不占位置。
 *
 * 形态名映射、跨度、《罕见》名单在 ./patternCatalogue.ts；统计表在 ./patternStats.ts（生成物）。
 */
import type { Bar } from './api.ts';
import { firstIndexAtOrAfter } from './candles.ts';
import { allPatterns, patternChain } from './candlestick/patternChain.js';
import { getPatternMetadata } from './candlestick/patternMetadata.js';
import { PATTERNS, isGapDependent } from './patternCatalogue.ts';
import { PATTERN_STATS, PATTERN_STATS_SAMPLE, TREND_SENSITIVITY, type PatternStat, type StatTier } from './patternStats.ts';

export type PatternDirection = 'bull' | 'bear';

export interface PatternHit {
  /** 形态确认那根在 bars 里的下标 */
  index: number;
  time: number;
  /** 库里的形态 id（hammer / bullishEngulfing …） */
  id: string;
  /** 中文名，直接显示给人看 */
  name: string;
  /** 形态按教科书语义指向哪边。只用来写角标，不作为展示理由 */
  direction: PatternDirection;
  /** 实测统计（默认口径 = 所有周期合并）。没有样本时是 null */
  stat: StatLike | null;
  /**
   * 统计档位：0 = 校正后没有可用增量，1~3 = 增量越显著越高。
   * 它**不是**上不上图的门槛（那会让开关变成死功能），而是排序、深浅和说明文字的等级。
   */
  tier: StatTier;
  /** 库给的有效置信度（confidence × contextFit）。只用于同根取舍，不显示 */
  fit: number;
}

/** 只挑界面用得到的字段，避免把整个统计对象挂到每个命中上 */
export interface StatLike {
  n: number;
  win: number;
  base: number;
  excess: number;
  z: number;
  q: number;
  edgeAtr: number;
}

const MIN_SAMPLES = PATTERN_STATS_SAMPLE.minSamples;

function statOf(id: string): StatLike | null {
  const s: PatternStat | undefined = PATTERN_STATS.all?.[id];
  if (!s) return null;
  return { n: s.n, win: s.win, base: s.base, excess: s.excess, z: s.z, q: s.q, edgeAtr: s.edgeAtr };
}

/**
 * 这个命中该不该上图、算第几档。
 *
 *   1. 有统计且样本够 → 看 tier（BH 校正后有没有增量、增量多大）。
 *   2. 没统计 / 样本不足 → 退回库的强度表：strong 直接显示、moderate 只在趋势对齐时显示。
 *      这一条是兜底，别删 —— 删了的话新加的形态、没采样的周期整页就空了。
 *   3. 跳空类（踢线、流星、上吊线、曙光初现）命中率 0.2%，统计样本都不够；
 *      库把它们定成 strong/moderate，会混进展示集合，按样本不足处理。
 */
function tierOf(id: string, meta: { direction: string; strength: string }, contextFit: number): StatTier {
  if (meta.direction === 'neutral') return 0;
  const stat = PATTERN_STATS.all?.[id];
  if (stat && stat.n >= MIN_SAMPLES) return stat.tier;
  if (isGapDependent(id)) return 0;
  if (meta.strength === 'strong') return 2;
  if (meta.strength === 'moderate' && contextFit >= 0.9) return 1;
  return 0;
}

/**
 * 同根多个形态里选哪个：跨度长的优先（信息多），再看方向增量，最后看有效置信度。
 * 「方向增量」取 excess；没有统计的按 0 算。
 */
function better(a: { span: number; excess: number }, b: { span: number; excess: number }, fitA: number, fitB: number): boolean {
  if (a.span !== b.span) return a.span > b.span;
  if (a.excess !== b.excess) return a.excess > b.excess;
  return fitA > fitB;
}

/** 重算时往回多带几根：趋势上下文看 10 根，最长的形态用 3 根，再留点余量 */
const LOOKBACK = 32;

/**
 * 趋势上下文的参数。
 *
 * 周期没传（脚本、自检、离线统计）就用库的默认灵敏度 5 —— 那条路径上的行为和改造前
 * 完全一致，教科书形状的用例不会因为统计表重新生成而跟着飘。
 *
 * 不开 resolveConflicts：它会在「两根重叠、方向相反」的形态里丢掉置信度低的那个，
 * 这个判定是跨 K 线的 —— 新来一根可能让前面已经标上的那根作废。增量扫描是按段重算的，
 * 开着它就永远对不上整段结果。本页一根 K 线只留一个形态，方向冲突在选的时候已经消化掉了。
 */
function trendOptions(interval?: string) {
  return {
    trendMethod: 'sma-slope' as const,
    trendPeriod: 10,
    contextSensitivity: sensitivityFor(interval),
    resolveConflicts: false,
  };
}

/** 周期名换算成秒。不认识就返回 0，交给下面按名字找 */
const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800,
  '12h': 43200, '1d': 86400, '1w': 604800,
};

/**
 * 趋势灵敏度：有本周期标定就用本周期，没有就取周期长度最接近的那个。
 *
 * 交易所给的周期比统计跑的（5m/15m/1h/4h/1d）多，还有 1m/30m/8h。这些退回库的默认值 5
 * 就等于把原来的毛病留在那三个周期上（1m 上几乎全拒、8h 上几乎全放）。按「时间尺度接近」
 * 借用邻近周期，比按名字借用更说得通 —— 灵敏度量的本来就是单位时间走多远。
 */
function sensitivityFor(interval?: string): number {
  if (!interval) return 5;
  const direct = TREND_SENSITIVITY[interval];
  if (typeof direct === 'number' && direct > 0) return direct;
  const target = INTERVAL_SECONDS[interval];
  if (!target) return 5;
  let best = 5;
  let bestDistance = Infinity;
  for (const [key, value] of Object.entries(TREND_SENSITIVITY)) {
    const seconds = INTERVAL_SECONDS[key];
    if (!seconds || !(value > 0)) continue;
    // 按比值取距离：1m↔5m 和 4h↔1d 都是 5 倍，在同一尺度上比较
    const distance = Math.abs(Math.log(target / seconds));
    if (distance < bestDistance) { bestDistance = distance; best = value; }
  }
  return best;
}

/** 自检用：把某个周期实际会用的灵敏度暴露出来 */
export { sensitivityFor as trendSensitivityFor };

/**
 * 扫一段 K 线，只保留 [keepFrom, to) 的命中，返回每根最多一个形态。
 *
 * 趋势上下文要前 10 根，所以实际从 keepFrom - LOOKBACK 开始算，算完把前面的丢掉 ——
 * 不这么做的话，每段开头十几根都会因为「没有上下文」而按 0.5 处理，和整段扫描对不上。
 */
function scanRange(bars: Bar[], keepFrom: number, to: number, interval?: string, displayOnly = true): PatternHit[] {
  const start = Math.max(0, keepFrom - LOOKBACK);
  const end = Math.min(bars.length, to);
  if (end - start <= 0) return [];
  const slice = bars.slice(start, end);
  const results = patternChain(slice, allPatterns, { trendContext: trendOptions(interval) });
  const best = new Map<number, PatternHit>();
  for (const result of results) {
    const info = PATTERNS[result.pattern];
    const meta = getPatternMetadata(result.pattern);
    if (!info || !meta) continue;
    const contextFit = typeof result.contextFit === 'number' ? result.contextFit : 0.5;
    const tier = tierOf(result.pattern, meta, contextFit);
    /**
     * 展示层只画「有教科书写法」的形态，不按统计门槛筛。
     *
     * 按门槛筛的话，实测 7 万根里没有一个形态过线 —— 开关会变成一个死功能，一根都画不出来。
     * 位置本身是有信息的（「这里出现过吞没」是事实），有问题的只是「吞没＝看涨」这个结论。
     * 所以位置照标、方向不标，档位（tier）降级为排序和深浅的依据，实测数字写在角标和图下列表里。
     */
    if (displayOnly && meta.direction === 'neutral') continue;
    const fit = (meta.confidence ?? 0) * contextFit;
    /**
     * 库返回的 index 是形态的**起始**那根（两/三根形态的 match 也从前一根开始）。
     * 图上要标的是「确认那根」—— 吞没标在吞没成立的那根，而不是被吞的那根。
     */
    const matchEnd = result.index + info.span - 1;
    const index = start + matchEnd;
    if (index < keepFrom) continue;
    const bar = slice[matchEnd];
    if (!bar) continue;
    const stat = statOf(result.pattern);
    const hit: PatternHit = {
      index,
      time: bar.time,
      id: result.pattern,
      name: info.name,
      direction: meta.direction === 'bullish' ? 'bull' : 'bear',
      stat,
      tier,
      fit,
    };
    const current = best.get(index);
    if (!current) {
      best.set(index, hit);
      continue;
    }
    const currentSpan = PATTERNS[current.id]?.span ?? 1;
    const candidate = { span: info.span, excess: stat?.excess ?? 0 };
    const incumbent = { span: currentSpan, excess: current.stat?.excess ?? 0 };
    if (better(candidate, incumbent, fit, current.fit)) best.set(index, hit);
  }
  return [...best.values()].sort((a, b) => a.index - b.index);
}

export interface PatternScan {
  /** 这一批结果算的是哪份 K 线。下一次拿引用比，没换就直接复用 */
  bars: Bar[];
  /** 按哪个周期标定的趋势灵敏度算的。换了周期就整段重算 */
  interval?: string;
  /** 这一批是不是已经按展示门槛过滤过。两种口径的结果不能混用 */
  displayOnly: boolean;
  hits: PatternHit[];
}

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
export function scanPatterns(previous: PatternScan | null, bars: Bar[], interval?: string, displayOnly = true): PatternScan {
  // 展示口径变了（比如从识别切到展示）不能复用旧结果，那一批是按另一个门槛筛过的
  if (previous && previous.displayOnly !== displayOnly) previous = null;
  const sameInterval = !previous || previous.interval === interval;
  if (previous && previous.bars === bars && sameInterval) return previous;
  // 趋势灵敏度是按周期标定的，同一批 K 线换周期要按新口径重算
  if (!previous || !sameInterval) return { bars, interval, displayOnly, hits: scanRange(bars, 0, bars.length, interval, displayOnly) };

  const old = previous.bars;
  const oldLen = old.length;
  const newLen = bars.length;
  if (oldLen === 0) return { bars, interval, displayOnly, hits: scanRange(bars, 0, newLen, interval, displayOnly) };
  const minLen = Math.min(oldLen, newLen);

  let prefix = 0;
  while (prefix < minLen && old[prefix] === bars[prefix]) prefix += 1;
  /**
   * 整段内容没变、只是换了一批对象（REST 快照重建数组）：结果原样复用。
   * 放在身份比较之后、且只在前缀为 0 时才做 —— 正常尾部更新前缀会直接停在其一处，
   * 不会每帧白扫两万根。
   */
  if (prefix === 0 && sameSeries(old, bars)) return { bars, interval, displayOnly, hits: previous.hits };
  /**
   * 身份一个都对不上、但内容其实连续（比如整页都是新对象 + 尾部多了一根）：
   * 按内容再找一遍前缀。
   */
  if (prefix === 0 && oldLen > 0) {
    while (prefix < minLen && sameBar(old[prefix]!, bars[prefix]!)) prefix += 1;
  }
  if (prefix === minLen && oldLen === newLen) return { bars, interval, displayOnly, hits: previous.hits };
  let suffix = 0;
  while (suffix < minLen - prefix && old[oldLen - 1 - suffix] === bars[newLen - 1 - suffix]) suffix += 1;
  if (suffix === 0 && prefix < minLen) {
    while (suffix < minLen - prefix && sameBar(old[oldLen - 1 - suffix]!, bars[newLen - 1 - suffix]!)) suffix += 1;
  }

  // 1) 纯头部插入：旧数据整个是新数据的后缀
  if (prefix === 0 && suffix >= oldLen - 1 && newLen > oldLen) {
    const shift = newLen - oldLen;
    const headEnd = Math.min(newLen, shift + LOOKBACK);
    const head = scanRange(bars, 0, headEnd, interval, displayOnly);
    const shifted = previous.hits.map((h) => ({ ...h, index: h.index + shift }));
    return { bars, interval, displayOnly, hits: [...head, ...shifted.filter((h) => h.index >= headEnd)] };
  }

  // 2) 尾部追加 / 只动最后几根：旧数据是新数据的前缀
  if (prefix >= oldLen - 2) {
    const tail = scanRange(bars, prefix, newLen, interval, displayOnly);
    return { bars, interval, displayOnly, hits: [...previous.hits.filter((h) => h.index < prefix), ...tail] };
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
        interval,
        displayOnly,
        hits: [
          ...scanRange(bars, 0, headEnd, interval, displayOnly),
          ...kept.filter((h) => h.index >= headEnd && h.index < alignedLen),
          ...scanRange(bars, Math.max(headEnd, alignedLen), newLen, interval, displayOnly),
        ],
      };
    }
  }

  // 4) 其它情况：整段重算
  return { bars, interval, displayOnly, hits: scanRange(bars, 0, newLen, interval, displayOnly) };
}

/**
 * 展示层的稀疏化，按档位分级。
 *
 * 统计档位高的（≥1，确实有增量或样本不足但库标 strong）留得密一点，隔 3 根；
 * 档位 0（描述性的，占绝大多数）隔 6 根。挤在一起时留档位高的，同档位再比方向增量、
 * 最后比有效置信度。
 *
 * 为什么不是一刀切：全按 3 根隔，实测密度 20%（一屏 100 根 20 个点），图上还是糊；
 * 全按 6 根隔，档位高的那些也跟着稀了。分级之后「有意义的」和「只是长这样」在视觉上
 * 能分开，而不用把后者删掉。
 *
 * 稀疏化只改「画几个」，识别结果本身不动，所以增量扫描和整段重算仍然是逐条一致的
 * （自检里也是拿未稀疏的结果比）。
 */
export const MIN_GAP: Record<StatTier, number> = { 0: 6, 1: 3, 2: 3, 3: 3 };

/** 同一根上挤了几个形态时留哪个：档位高的优先，再看方向增量，最后比有效置信度 */
export function betterHit(a: PatternHit, b: PatternHit): boolean {
  return a.tier > b.tier
    || (a.tier === b.tier && (a.stat?.excess ?? 0) > (b.stat?.excess ?? 0))
    || (a.tier === b.tier && (a.stat?.excess ?? 0) === (b.stat?.excess ?? 0) && a.fit > b.fit);
}

export function thinHits(hits: PatternHit[], gap: Record<StatTier, number> = MIN_GAP): PatternHit[] {
  const out: PatternHit[] = [];
  for (const hit of hits) {
    const prev = out[out.length - 1];
    const floor = Math.min(gap[hit.tier], gap[prev?.tier ?? hit.tier]);
    if (prev && hit.index - prev.index < floor) {
      if (betterHit(hit, prev)) out[out.length - 1] = hit;
      continue;
    }
    out.push(hit);
  }
  return out;
}

/**
 * 每一根上都有哪些形态（不稀疏化）。
 *
 * 图上的箭头只是稀疏之后的一小部分：两根挨着的时候只留了档位高的那个。
 * 手指点在圆点正上方那一根时，命中的可能是被稀疏掉的那个 —— 点开却只看到「没有形态」，
 * 看起来就是「点了没用」。所以点按走这一份全量的，同一个下标多选时用 betterHit 挑。
 */
export function groupHitsByIndex(hits: PatternHit[]): Map<number, PatternHit> {
  const map = new Map<number, PatternHit>();
  for (const hit of hits) {
    const prev = map.get(hit.index);
    if (!prev || betterHit(hit, prev)) map.set(hit.index, hit);
  }
  return map;
}

/**
 * 一次算完。脚本、自检、统计用。
 *
 * 默认**不过展示门槛**：自检要验的是「规则认不认得出教科书形状」，统计要的是全部命中。
 * 展示那层过滤是另一个开关 —— 混在一起的话，教科书用例会因为统计说「这个形态没有增量」
 * 而变成不命中，那是两件事。
 */
export function detectPatterns(bars: Bar[], interval?: string, displayOnly = false): PatternHit[] {
  return scanPatterns(null, bars, interval, displayOnly).hits;
}

/** 库里会被展示的形态 id（去掉 neutral 的），给 README 和自检对口径用 */
export { PATTERN_IDS } from './patternCatalogue.ts';
