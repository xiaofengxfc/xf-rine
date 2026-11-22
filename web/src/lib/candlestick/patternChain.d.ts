import type { Bar } from '../api.ts';

/**
 * 类型声明：vendor 进来的 cm45t3r/candlestick（MIT）只有 JSDoc，没有 .d.ts。
 * 这里只声明我们用到的两个入口，够用即可。
 */
export interface ChainMatch {
  index: number;
  pattern: string;
  match: Bar[];
  trendContext?: 'uptrend' | 'downtrend' | 'sideways';
  contextFit?: number;
}

export interface ChainPattern {
  name: string;
  fn: (candles: unknown[]) => number[];
  paramCount?: number;
}

export interface TrendContextOptions {
  trendMethod?: 'sma-slope' | 'ema-slope' | 'pct-change';
  trendPeriod?: number;
  contextSensitivity?: number;
  resolveConflicts?: boolean;
}

export const allPatterns: ChainPattern[];
export function patternChain(
  candles: Bar[],
  patterns?: ChainPattern[],
  options?: { strict?: boolean; trendContext?: TrendContextOptions },
): ChainMatch[];
