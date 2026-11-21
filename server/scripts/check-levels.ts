/**
 * 命令行体检：拿真实 K 线跑一遍关键位引擎，把结果打到终端，再跑一组自检。
 *
 * 用法：
 *   pnpm check:levels                 # BTC_USDT 15m
 *   pnpm check:levels ETH_USDT 1h
 *
 * 算法跑在 Python sidecar 里（上游 V3Fusion 原版），所以这里自检的是「接口那一层」
 * 必须成立的性质：双概率自洽、区宽夹逼、距离带、每侧限流、确定性、共振不越界。
 * 算法内部的性质（体积守恒、枢轴因果性）由 sidecar/tests 里的 Python 用例负责。
 */
import { analyzeBars, stopSidecar } from '../src/sr/client.js';
import type { Zone } from '../src/sr/types.js';

const contract = process.argv[2] ?? 'BTC_USDT';
const interval = process.argv[3] ?? '15m';

/** 交易所周期 -> 引擎周期代号 */
const TF: Record<string, string> = {
  '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '8h': 'H8', '1d': 'D1', '7d': 'W1',
};

interface GateCandle { t: number; o: string; h: string; l: string; c: string; v: number }

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }

/** 拉不到就造一段固定的随机游走：体检照样能跑，只是不是真行情 */
function synthetic(n = 600): Bar[] {
  const out: Bar[] = [];
  let px = 30000;
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const t0 = 1_700_000_000;
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.5) * 0.02;
    const open = px;
    px = px * (1 + drift);
    const high = Math.max(open, px) * (1 + rnd() * 0.004);
    const low = Math.min(open, px) * (1 - rnd() * 0.004);
    out.push({ time: t0 + i * 900, open, high, low, close: px, volume: 10 + rnd() * 100 });
  }
  return out;
}

async function fetchBars(): Promise<{ bars: Bar[]; real: boolean }> {
  try {
    // 带上超时：这里没有超时的话，网络不通时会一直挂着，看终端就像卡死了
    const res = await fetch(
      'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=' + contract + '&interval=' + interval + '&limit=600',
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = (await res.json()) as GateCandle[];
    if (!Array.isArray(raw) || raw.length < 120) throw new Error('返回条数不足');
    const bars = raw.map((c) => ({
      time: Number(c.t), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v),
    }));
    return { bars, real: true };
  } catch (e) {
    console.warn('拉真实行情失败（' + (e as Error).message + '），改用合成序列');
    return { bars: synthetic(), real: false };
  }
}

const { bars, real } = await fetchBars();
const closed = bars.slice(0, -1);
const live = bars[bars.length - 1]!.close;
const tf = TF[interval] ?? interval.toUpperCase();

const r = await analyzeBars({
  symbol: contract, tf, frames: [{ tf, bars: closed }], n_zones: 3, direction: 'both', mtf: true,
});

/** 距离改挂到「现价」上，和 /api/levels 做的事一样 */
const A = r.engine.atr > 0 ? r.engine.atr : 1;
const zones: Zone[] = r.zones.map((z) => ({
  ...z,
  distance_pct: Number((((z.center - live) / live) * 100).toFixed(4)),
  distance_atr: Number(((z.center - live) / A).toFixed(4)),
  zone_type: (z.high < live ? 'support' : z.low > live ? 'resistance' : z.center <= live ? 'support' : 'resistance') as Zone['zone_type'],
}));

const fmt = (v: number, d = 2) => v.toFixed(d).padStart(7);
console.log('');
console.log(contract + ' ' + interval + (real ? '（交易所实时）' : '（合成序列）') +
  '  用了 ' + closed.length + ' 根已收盘 K 线，现价 ' + live.toFixed(4));
console.log('ATR14 = ' + r.engine.atr.toFixed(4) + '（' + (r.engine.atr_pct ?? 0).toFixed(2) + '%）  数据 ' + r.data_bars + ' 根' +
  '  概率模型 ' + (r.engine.prob_ready ? '已加载' : '缺失') + '  校准表 ' + (r.engine.calibrated ? '已加载' : '缺失'));
if (r.mtf_zones.length) console.log('共振周期：' + r.mtf_zones.map((m) => m.tf).join(' / '));
console.log('');
console.log('  中枢          类型  触及%  守住%  有效%  事件  档位  区宽   距现价    停滞');
for (const z of zones) {
  const price = z.center.toFixed(z.center >= 1000 ? 1 : 5).padStart(10);
  const pct = (v: number | null) => (v === null ? '  —  ' : (v * 100).toFixed(0).padStart(4) + '%');
  console.log(
    price + '  ' + (z.zone_type === 'support' ? '支撑' : '阻力') +
    '  ' + pct(z.p_touch) + '  ' + pct(z.p_hold) + '  ' + pct(z.p_effective) +
    '  ' + String(z.n_events).padStart(3) +
    '  ' + String(z.bucket ?? '—').padStart(3) +
    '  ' + fmt(z.width_atr) + 'A' +
    '  ' + (z.distance_pct >= 0 ? '+' : '') + z.distance_pct.toFixed(2) + '%' +
    '  ' + z.p_stall.toFixed(2) +
    (z.tf_count > 1 ? '  共振 ' + z.tf_count + '（' + z.tfs + '）' : ''),
  );
}
if (zones.length === 0) console.log('  （没有位通过筛选）');
console.log('');
console.log('最近位：' + (r.summary.headline || '—'));

// ---- 自检 ----
console.log('');
console.log('自检：');
const failures: string[] = [];

// 1) 确定性：同样输入必须同样输出
try {
  const again = await analyzeBars({ symbol: contract, tf, frames: [{ tf, bars: closed }], n_zones: 3, direction: 'both', mtf: true });
  if (JSON.stringify(again.zones) !== JSON.stringify(r.zones)) failures.push('确定性：两次调用结果不同');
} catch (e) {
  failures.push('确定性：第二次调用失败 ' + (e as Error).message);
}

// 2) 双概率自洽：p_eff = p_touch × p_hold，且都落在 (0,1)
for (const z of zones) {
  if (z.p_touch === null || z.p_hold === null || z.p_effective === null) {
    if (r.engine.prob_ready) failures.push('概率：模型已加载但 ' + z.center + ' 没有概率');
    continue;
  }
  for (const [name, v] of [['p_touch', z.p_touch], ['p_hold', z.p_hold], ['p_effective', z.p_effective]] as const) {
    if (!(v > 0 && v < 1)) failures.push('概率：' + name + ' = ' + v + ' 不在 (0,1)');
  }
  if (Math.abs(z.p_touch * z.p_hold - z.p_effective) > 1e-3) {
    failures.push('概率：' + z.center + ' 的 p_effective 不等于 p_touch×p_hold（' + z.p_effective + ' vs ' + (z.p_touch * z.p_hold).toFixed(4) + '）');
  }
}

// 3) 区宽夹逼：不能靠「给一个超宽的区」去刷守住率
for (const z of zones) {
  if (z.width_atr < 0.3 - 1e-6 || z.width_atr > 1.2 + 1e-6) {
    failures.push('区宽夹逼：' + z.center + ' 的区宽 ' + z.width_atr.toFixed(2) + ' ATR 越界');
  }
}

// 4) 引擎按最后一根已收盘 K 线筛选 0.5~5 ATR 距离带，与回测口径一致。
// 上面的 zones 已按未收盘 K 线的最新价重算距离，价格跨过边界时不应反向判引擎失败。
for (const z of r.zones) {
  const d = Math.abs(z.distance_atr);
  if (d < 0.5 - 1e-6 || d > 5 + 1e-6) failures.push('距离带：' + z.center + ' 距现价 ' + d.toFixed(2) + ' ATR 越界');
}

// 5) 每侧限流：n_zones=3 时每侧最多 3 个
for (const role of ['support', 'resistance'] as const) {
  const n = zones.filter((z) => z.zone_type === role).length;
  if (n > 3) failures.push('每侧限流：' + role + ' 有 ' + n + ' 个，超过 3');
}

// 6) 共振：tf_count 至少 1，且 tfs 里的周期不能是主周期
for (const z of zones) {
  if (z.tf_count < 1) failures.push('共振：' + z.center + ' 的 tf_count 小于 1');
  if (z.tfs.split('+').includes(tf)) failures.push('共振：主周期 ' + tf + ' 被算进了共振列表');
}

// 7) 汇总里的最近位必须真的在 zones 里
if (r.summary.nearest) {
  const hit = zones.some((z) => Math.abs(z.center - r.summary.nearest!.center) < 1e-6);
  if (!hit) failures.push('汇总：summary.nearest 不在 zones 里（说明汇总和列表不是同一次计算）');
}

if (failures.length === 0) {
  console.log('  ✓ 全部通过');
  stopSidecar();
} else {
  for (const f of failures) console.log('  ✗ ' + f);
  stopSidecar();
  process.exit(1);
}
