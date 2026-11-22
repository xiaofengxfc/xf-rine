/**
 * 形态目录：库的 id 对应到中文名、确认根跨度，以及几个需要人记住的口径。
 *
 * 单独一个文件，是因为三处都要用，而且不能互相依赖：
 *   - web/src/lib/patterns.ts        识别与展示
 *   - web/scripts/pattern-stats.ts   跑实测统计（它不能反过来 import patterns.ts，
 *                                    否则会和生成的 patternStats.ts 形成循环）
 *   - web/scripts/check-patterns.ts  自检
 *
 * 规则本身不在这里，全部来自 vendor 的 cm45t3r/candlestick（见 ./candlestick/README.md）。
 */

export interface PatternInfo {
  /** 中文名，直接显示给人看 */
  name: string;
  /** 这个形态用几根 K 线确认（优先级也按它排） */
  span: 1 | 2 | 3 | 4;
}

/**
 * 库的 id 一共 29 个，有的只是同一个形状的不同实体方向，中文名合并。
 * 新增 id 时这里必须一起加 —— check-patterns 会对着库的 allPatterns 逐条核对。
 */
export const PATTERNS: Record<string, PatternInfo> = {
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
 * 规则里写死了「真实价格缺口」的判定 —— 这一根的开盘价要越过前一根的高/低点。
 *
 * 加密永续是 24/7 连续报价，下一根开盘价通常就是上一根的收盘价，落在前一根的最高
 * 最低之间，所以这几个判定**很罕见**。实测 70456 根真实 K 线（BTC/ETH/DOGE/SOL ×
 * 5m~1d，Gate）：踢线 91 次、曙光初现 15 次、流星 8 次、上吊线 4 次，合计 0.2%。
 *
 * 只标记「罕见」，不参与展示过滤。是否显示交给实测统计和密度规则。
 */
export const GAP_DEPENDENT: ReadonlySet<string> = new Set([
  'hangingMan',
  'shootingStar',
  'piercingLine',
  'bullishKicker',
  'bearishKicker',
]);

export function isGapDependent(id: string): boolean {
  return GAP_DEPENDENT.has(id);
}

/** 给 README、自检和统计脚本用的平铺清单 */
export const PATTERN_IDS: { id: string; name: string; span: 1 | 2 | 3 | 4 }[] =
  Object.entries(PATTERNS).map(([id, info]) => ({ id, ...info }));
