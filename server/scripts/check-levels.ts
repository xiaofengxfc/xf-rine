/**
 * 命令行体检：拉真实 K 线，跑一遍支撑阻力识别和止盈止损推导，把结果打到终端。
 * 用法： pnpm -F server exec tsx scripts/check-levels.ts BTC_USDT 15m
 */
import { detectLevels, planBracket, type Bar } from '../src/levels.js';

const contract = process.argv[2] ?? 'BTC_USDT';
const interval = process.argv[3] ?? '15m';

interface GateCandle { t: number; o: string; h: string; l: string; c: string; v: number }

const res = await fetch(
  `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${interval}&limit=500`,
);
if (!res.ok) {
  console.error('拉数据失败', res.status, await res.text());
  process.exit(1);
}
const raw = (await res.json()) as GateCandle[];
const all: Bar[] = raw.map((c) => ({
  time: Number(c.t), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v),
}));
const closed = all.slice(0, -1);
const live = all[all.length - 1]!.close;

const set = detectLevels(closed, { pivotWindow: 3, maxLevels: 8 });
console.log(`\n${contract} ${interval}  用了 ${closed.length} 根已收盘 K 线，现价 ${live}`);
console.log(`ATR14 = ${set.atr.toFixed(4)}  (${((set.atr / live) * 100).toFixed(2)}%)`);
console.log(`区间 ${set.rangeLow} - ${set.rangeHigh}`);

console.log('\n位               角色    强度  触及  假破  量比   距现价');
for (const l of set.levels) {
  const p = l.price.toFixed(l.price >= 1000 ? 1 : 4).padStart(10);
  console.log(
    `${p}  ${l.role === 'support' ? '支撑' : '阻力'}  ${String(Math.round(l.strength)).padStart(4)}  ` +
    `${String(l.touches).padStart(4)}  ${String(l.failures).padStart(4)}  ` +
    `${l.volumeRatio.toFixed(2)}  ${l.distancePct >= 0 ? '+' : ''}${l.distancePct.toFixed(2)}%`,
  );
}
if (set.levels.length === 0) console.log('  （没有位通过阈值）');

const liveSet = { ...set, last: live };
for (const dir of ['long', 'short'] as const) {
  const b = planBracket(liveSet, dir, { minRR: 1.5 });
  if (!b) { console.log(`\n${dir} 方案：算不出来`); continue; }
  console.log(
    `\n${dir === 'long' ? '做多' : '做空'}方案  入场 ${b.entry}  止损 ${b.stop.toFixed(4)} (${b.stopDistancePct}%)  ` +
    `止盈 ${b.target.toFixed(4)} (${b.targetDistancePct}%)  盈亏比 ${b.riskReward}` +
    `${b.acceptable ? '' : '  ← 低于最低盈亏比 ' + b.minRR + '，不建议'}`,
  );
  console.log(`  止损依据：${b.stopSource}`);
  console.log(`  止盈依据：${b.targetSource}`);
}

// ---- 结构性自检 ----
console.log('\n自检：');
const failures: string[] = [];

// 1) 确定性：同样输入必须同样输出
const a1 = JSON.stringify(detectLevels(closed, { pivotWindow: 3 }));
const a2 = JSON.stringify(detectLevels(closed.map((b) => ({ ...b })), { pivotWindow: 3 }));
if (a1 !== a2) failures.push('确定性：两次调用结果不同');

// 2) no-lookahead：最后一根 bar 是最极端的那根，它自己不能成为一个位
{
  const flat = 100;
  const synth: Bar[] = [];
  for (let i = 0; i < 120; i++) {
    const wobble = Math.sin(i / 4) * 0.6;
    synth.push({ time: 1_700_000_000 + i * 900, open: flat + wobble, high: flat + wobble + 0.4, low: flat + wobble - 0.4, close: flat + wobble, volume: 1000 });
  }
  // 最后一根是根插到 200 的大阳线：它右侧没有数据，摆动点判定不该把它当成位
  synth[synth.length - 1] = { time: 1_700_000_000 + 119 * 900, open: flat, high: 200, low: flat - 0.4, close: 200, volume: 5000 };
  const s = detectLevels(synth, { pivotWindow: 3, maxDistancePct: 500, minStrength: 0 });
  if (s.levels.some((l) => l.price > 150)) failures.push('no-lookahead：最新的未确认极值被当成了位');
}

// 3) 上下都有位：造一段中间价，两侧都应该有位
{
  const synth: Bar[] = [];
  for (let i = 0; i < 200; i++) {
    const v = Math.sin(i / 6) * 3;
    synth.push({ time: 1_700_000_000 + i * 900, open: 100 + v, high: 100 + v + 0.8, low: 100 + v - 0.8, close: 100 + v, volume: 1000 });
  }
  const s = detectLevels(synth, { pivotWindow: 3, maxLevels: 8, minStrength: 0, maxDistancePct: 20 });
  const sup = s.levels.filter((l) => l.role === 'support').length;
  const resv = s.levels.filter((l) => l.role === 'resistance').length;
  if (sup === 0 || resv === 0) failures.push(`上下平衡：支撑 ${sup} 个 / 阻力 ${resv} 个，有一侧是空的`);
}

// 4) 合并：容差内的相邻位不该在结果里重复出现
{
  const sorted = [...set.levels].sort((x, y) => x.price - y.price);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.price - sorted[i - 1]!.price;
    if (gap < set.atr * 0.45) failures.push(`去重：${sorted[i - 1]!.price} 与 ${sorted[i]!.price} 间距小于一个容差`);
  }
}

if (failures.length === 0) console.log('  全部通过（确定性 / no-lookahead / 上下平衡 / 同带合并）');
else for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length === 0 ? 0 : 1);
