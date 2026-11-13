
/**
 * 回测用到的指标。
 *
 * 每个指标都实现同一个接口：`at(i)` 返回第 i 根的值，数据不够时返回 NaN。
 * 统一成"按需取值"之后，引擎里不用关心指标是递归的（EMA）还是窗口的（RSI），
 * 也不用预先算整条数组。
 *
 * 所有指标只允许向后看：`at(i)` 的实现里绝不能出现 i+1 或更后面的下标。
 */

import type { Candle, IndicatorSeries, Params } from './backtest.js';

/** 指标名 -> 需要多少根才出第一个有效值 */
const WARMUP: Record<string, (p: Params) => number> = {
  close: () => 1,
  ema: (p) => Math.max(1, Math.round(p.period ?? 20)),
  sma: (p) => Math.max(1, Math.round(p.period ?? 20)),
  rsi: (p) => Math.max(2, Math.round(p.period ?? 14)) + 1,
  atr: (p) => Math.max(2, Math.round(p.period ?? 14)) + 1,
  // 突破类看的是前 N 根的最高/最低，天然要 N+1 根
  highest: (p) => Math.max(1, Math.round(p.period ?? 20)) + 1,
  lowest: (p) => Math.max(1, Math.round(p.period ?? 20)) + 1,
  volumeSma: (p) => Math.max(1, Math.round(p.period ?? 20)),
  // 关键位：用最近 N 根的摆动高/低点，N 给默认值
  swingHigh: (p) => Math.max(3, Math.round(p.period ?? 20)) + 1,
  swingLow: (p) => Math.max(3, Math.round(p.period ?? 20)) + 1,
  // 关键位由外部时间线提供，不按 K 线预热
  zoneSupport: () => 1,
  zoneResistance: () => 1,
  // 注意 atr 单独用 atrPeriod：同一个 params 里既有 EMA 的 period 又有 ATR 的周期时，
  // 共用一个键会让止损距离悄悄跟着指标周期变
};

export function warmupFor(name: string, params: Params): number {
  const fn = WARMUP[name];
  if (!fn) return 30;
  // ATR 的周期单独一个键：止损距离不该随着 EMA 周期变化
  if (name === 'atr') return fn({ period: params.atrPeriod ?? params.period ?? 14 });
  return fn(params);
}

export function buildIndicator(name: string, candles: Candle[], params: Params): IndicatorSeries {
  const n = candles.length;
  const nan = (): IndicatorSeries => ({ at: () => NaN });

  switch (name) {
    case 'close':
      return { at: (i) => (i >= 0 && i < n ? candles[i]!.c : NaN) };

    case 'open':
      return { at: (i) => (i >= 0 && i < n ? candles[i]!.o : NaN) };

    case 'sma': {
      const period = Math.max(1, Math.round(params.period ?? 20));
      const vals = new Array<number>(n).fill(NaN);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += candles[i]!.c;
        if (i >= period) sum -= candles[i - period]!.c;
        if (i >= period - 1) vals[i] = sum / period;
      }
      return { at: (i) => (i >= 0 && i < n ? vals[i]! : NaN) };
    }

    case 'ema': {
      const period = Math.max(1, Math.round(params.period ?? 20));
      const k = 2 / (period + 1);
      const vals = new Array<number>(n).fill(NaN);
      let prev = NaN;
      for (let i = 0; i < n; i++) {
        const c = candles[i]!.c;
        if (i === 0) prev = c;
        else if (Number.isNaN(prev)) prev = c;
        else prev = c * k + prev * (1 - k);
        // 前 period-1 根还在"预热"，不给值：把预热期的 EMA 拿去比大小，等于让策略在噪音上开仓
        if (i >= period - 1) vals[i] = prev;
      }
      return { at: (i) => (i >= 0 && i < n ? vals[i]! : NaN) };
    }

    case 'rsi': {
      // Wilder 平滑，和 TradingView 默认口径一致
      const period = Math.max(2, Math.round(params.period ?? 14));
      const vals = new Array<number>(n).fill(NaN);
      let avgGain = 0;
      let avgLoss = 0;
      for (let i = 1; i < n; i++) {
        const change = candles[i]!.c - candles[i - 1]!.c;
        const gain = Math.max(0, change);
        const loss = Math.max(0, -change);
        if (i <= period) {
          avgGain += gain / period;
          avgLoss += loss / period;
          if (i === period) {
            const rs = avgLoss > 0 ? avgGain / avgLoss : avgGain > 0 ? Infinity : 0;
            vals[i] = Number.isFinite(rs) ? 100 - 100 / (1 + rs) : 100;
          }
        } else {
          avgGain = (avgGain * (period - 1) + gain) / period;
          avgLoss = (avgLoss * (period - 1) + loss) / period;
          const rs = avgLoss > 0 ? avgGain / avgLoss : avgGain > 0 ? Infinity : 0;
          vals[i] = Number.isFinite(rs) ? 100 - 100 / (1 + rs) : 100;
        }
      }
      return { at: (i) => (i >= 0 && i < n ? vals[i]! : NaN) };
    }

    case 'atr': {
      const period = Math.max(2, Math.round(params.atrPeriod ?? params.period ?? 14));
      const vals = new Array<number>(n).fill(NaN);
      let prev = NaN;
      for (let i = 1; i < n; i++) {
        const tr = Math.max(
          candles[i]!.h - candles[i]!.l,
          Math.abs(candles[i]!.h - candles[i - 1]!.c),
          Math.abs(candles[i]!.l - candles[i - 1]!.c),
        );
        if (i <= period) {
          prev = Number.isNaN(prev) ? tr : prev + tr;
          if (i === period) { prev = prev / period; vals[i] = prev; }
        } else {
          prev = (prev * (period - 1) + tr) / period;
          vals[i] = prev;
        }
      }
      return { at: (i) => (i >= 0 && i < n ? vals[i]! : NaN) };
    }

    case 'highest': {
      // 前 period 根的收盘最高（不含当前根 —— 含了就变成"今天最高比今天高"，永远不真）
      const period = Math.max(1, Math.round(params.period ?? 20));
      const vals = new Array<number>(n).fill(NaN);
      for (let i = period; i < n; i++) {
        let m = -Infinity;
        for (let j = i - period; j < i; j++) m = Math.max(m, candles[j]!.h);
        vals[i] = m;
      }
      return { at: (i) => (i >= 0 && i < n ? vals[i]! : NaN) };
    }

    case 'lowest': {
      const period = Math.max(1, Math.round(params.period ?? 20));
      const vals = new Array<number>(n).fill(NaN);
      for (let i = period; i < n; i++) {
        let m = Infinity;
        for (let j = i - period; j < i; j++) m = Math.min(m, candles[j]!.l);
        vals[i] = m;
      }
      return { at: (i) => (i >= 0 && i < n ? vals[i]! : NaN) };
    }

    case 'volumeSma': {
      const period = Math.max(1, Math.round(params.period ?? 20));
      const vals = new Array<number>(n).fill(NaN);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += candles[i]!.v;
        if (i >= period) sum -= candles[i - period]!.v;
        if (i >= period - 1) vals[i] = sum / period;
      }
      return { at: (i) => (i >= 0 && i < n ? vals[i]! : NaN) };
    }

    case 'swingHigh': {
      // 摆动高点：左右各 k 根都更低才算一个高点。右侧必须已经收盘，所以第 i 根能看到的
      // 最后一个确认点是 i-k。这就是"因果性"—— 不用确认时刻之后的摆动点
      const k = Math.max(1, Math.round(params.period ?? 10));
      const vals = new Array<number>(n).fill(NaN);
      for (let i = 2 * k; i < n; i++) {
        let found = NaN;
        for (let p = i - k; p >= k; p--) {
          let isHigh = true;
          for (let j = p - k; j <= p + k; j++) {
            if (j !== p && candles[j]!.h >= candles[p]!.h) { isHigh = false; break; }
          }
          if (isHigh) { found = candles[p]!.h; break; }
        }
        vals[i] = found;
      }
      return { at: (i) => (i >= 0 && i < n ? vals[i]! : NaN) };
    }

    case 'swingLow': {
      const k = Math.max(1, Math.round(params.period ?? 10));
      const vals = new Array<number>(n).fill(NaN);
      for (let i = 2 * k; i < n; i++) {
        let found = NaN;
        for (let p = i - k; p >= k; p--) {
          let isLow = true;
          for (let j = p - k; j <= p + k; j++) {
            if (j !== p && candles[j]!.l <= candles[p]!.l) { isLow = false; break; }
          }
          if (isLow) { found = candles[p]!.l; break; }
        }
        vals[i] = found;
      }
      return { at: (i) => (i >= 0 && i < n ? vals[i]! : NaN) };
    }

    default:
      return nan();
  }
}

/** 界面上能选的全部指标。加一个要同时改这里的 WARMUP 和 buildIndicator */
export const INDICATORS: { id: string; label: string; params: { name: string; label: string; def: number }[] }[] = [
  { id: 'sma', label: 'SMA', params: [{ name: 'period', label: '周期', def: 20 }] },
  { id: 'ema', label: 'EMA', params: [{ name: 'period', label: '周期', def: 20 }] },
  { id: 'rsi', label: 'RSI', params: [{ name: 'period', label: '周期', def: 14 }] },
  { id: 'atr', label: 'ATR', params: [{ name: 'period', label: '周期', def: 14 }] },
  { id: 'highest', label: '前 N 根最高', params: [{ name: 'period', label: '周期', def: 20 }] },
  { id: 'lowest', label: '前 N 根最低', params: [{ name: 'period', label: '周期', def: 20 }] },
  { id: 'volumeSma', label: '成交量均值', params: [{ name: 'period', label: '周期', def: 20 }] },
  { id: 'swingHigh', label: '摆动高点', params: [{ name: 'period', label: '左右根数', def: 10 }] },
  { id: 'swingLow', label: '摆动低点', params: [{ name: 'period', label: '左右根数', def: 10 }] },
  { id: 'close', label: '收盘价', params: [] },
  // 这两个不是从 K 线算的：来自关键位引擎，由回测/实盘那边作为外部序列喂进来。
  // 放在同一个清单里，条件编辑器就能像选 EMA 一样选它们。
  { id: 'zoneSupport', label: '最近支撑价', params: [] },
  { id: 'zoneResistance', label: '最近阻力价', params: [] },
];
