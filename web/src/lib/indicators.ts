import type { Bar } from './api.ts';

/**
 * RSI，用 Wilder 的平滑法（和 TradingView 默认口径一致）。
 *
 * 自己写而不是引指标库：lightweight-charts-indicators 会把 1869 个指标一起打进包，
 * 构建从 1.6 秒变成 23 秒、产物 11.8 MB，只为画一条线不值当。RSI 本身二十行就够。
 */
export function rsi(bars: Bar[], period = 14): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  if (bars.length < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = bars[i]!.close - bars[i - 1]!.close;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;

  const push = (i: number): void => {
    // 全程只涨没有回落时 RSI 就是 100，别算成 Infinity 塞进图表
    const value = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    out.push({ time: bars[i]!.time, value: Number(value.toFixed(2)) });
  };

  push(period);
  for (let i = period + 1; i < bars.length; i++) {
    const d = bars[i]!.close - bars[i - 1]!.close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    push(i);
  }
  return out;
}
