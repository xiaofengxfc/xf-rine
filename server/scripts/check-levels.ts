/**
 * 命令行体检：拉真实 K 线，跑一遍支撑阻力识别和止盈止损推导，把结果打到终端。
 * 用法： pnpm -F server exec tsx scripts/check-levels.ts BTC_USDT 15m
 */
import { detectLevels, planBracket, type Bar, type LevelSet } from '../src/levels.js';

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
  const market = planBracket(liveSet, dir, { minRR: 1.5, entryMode: 'market' });
  console.log(
    `\n${dir === 'long' ? '做多' : '做空'}方案  入场 ${b.entry} (${b.entryKind}` +
    `${b.entryKind === 'market' ? '' : `，距现价 ${b.entryDistancePct}% / ${b.entryDistanceAtr} ATR`})  ` +
    `止损 ${b.stop.toFixed(4)} (${b.stopDistancePct}%)  ` +
    `止盈 ${b.target.toFixed(4)} (${b.targetDistancePct}%)  盈亏比 ${b.riskReward}` +
    `${b.acceptable ? '' : '  ← 低于最低盈亏比 ' + b.minRR + '，不建议'}`,
  );
  console.log(`  入场依据：${b.entrySource}`);
  console.log(`  止损依据：${b.stopSource}`);
  console.log(`  止盈依据：${b.targetSource}`);
  if (market) console.log(`  对比：按现价进是 ${market.riskReward}（同目标、同结构）`);
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


/** 造一个只有几条位的 LevelSet，用来把「入场该放哪儿」这件事单独拿出来验 */
function mkSet(levels: { price: number; strength: number }[], last: number, atrValue: number, range = 3): LevelSet {
  const full = levels
    .map((l) => ({
      price: l.price,
      role: (l.price <= last ? 'support' : 'resistance') as 'support' | 'resistance',
      strength: l.strength,
      touches: 3,
      failures: 0,
      volumeRatio: 0.5,
      distancePct: Math.round(((l.price - last) / last) * 10000) / 100,
      lastTouch: 1_700_000_000,
      zoneLow: l.price * 0.999,
      zoneHigh: l.price * 1.001,
    }))
    .sort((x, y) => y.price - x.price);
  return {
    levels: full,
    atr: atrValue,
    last,
    rangeHigh: last + range * atrValue,
    rangeLow: last - range * atrValue,
    nearestSupport: null,
    nearestResistance: null,
  };
}

// 5) 回踩入场：入场落在支撑上沿，止损在入场下方，盈亏比要比按现价进更高
{
  const s = mkSet([{ price: 99, strength: 80 }, { price: 104, strength: 80 }], 100, 1);
  const b = planBracket(s, 'long', {});
  const m = planBracket(s, 'long', { entryMode: 'market' });
  if (!b || !m) failures.push('回踩：算不出来');
  else {
    if (b.entryKind !== 'level') failures.push('回踩：该认出结构位入场，得到 ' + b.entryKind);
    if (Math.abs(b.entry - 99.15) > 1e-6) failures.push('回踩：入场该是支撑上沿 99.15，得到 ' + b.entry);
    if (!(b.entry < b.stop === false)) failures.push('回踩：止损没有在入场下方');
    if (!(b.target > b.entry)) failures.push('回踩：止盈没有在入场上方');
    if (!(b.riskReward > m.riskReward)) {
      failures.push('回踩：盈亏比没有比按现价进更高（' + b.riskReward + ' vs ' + m.riskReward + '）');
    }
    if (b.entryDistancePct >= 0) failures.push('回踩：多单入场该低于现价，偏离算成 ' + b.entryDistancePct + '%');
    if (Math.abs(b.entryDistanceAtr - 0.85) > 0.01) failures.push('回踩：ATR 偏离该是 0.85，得到 ' + b.entryDistanceAtr);
  }
}

// 6) 价位就贴在现价身上（半个垫子之内）时不能自称回踩 —— 挂在那儿等于立刻成交
{
  const s = mkSet([{ price: 99.9, strength: 80 }], 100, 1, 0.5);
  const b = planBracket(s, 'long', {});
  if (b && b.entryKind === 'level') failures.push('贴身上：差了 0.1 还当成回踩位');
}

// 7) 位太远（3 个 ATR）就不该等它，退回近一点的入场
{
  const s = mkSet([{ price: 97, strength: 80 }], 100, 1, 0.5);
  const b = planBracket(s, 'long', {});
  if (!b) failures.push('太远：算不出来');
  else {
    if (b.entryKind === 'level') failures.push('太远：3 ATR 外的位还在等');
    if (b.entryKind !== 'atr') failures.push('太远：该退回 ATR 回撤，得到 ' + b.entryKind);
    if (Math.abs(b.entry - 99.4) > 1e-6) failures.push('太远：ATR 回撤该是 99.4，得到 ' + b.entry);
  }
}

// 7b) 够得着但离得太远（超过 3%）也不能挂 —— 交易所的偏离上限会直接拒单
{
  const s = mkSet([{ price: 96.5, strength: 80 }], 100, 2.5, 0.5);
  const b = planBracket(s, 'long', {});
  if (!b) failures.push('太远百分比：算不出来');
  else {
    if (b.entryKind !== 'market') failures.push('太远百分比：3% 以外还挂着等，得到 ' + b.entryKind);
    if (Math.abs(b.entry - 100) > 1e-9) failures.push('太远百分比：该退回现价 100，得到 ' + b.entry);
  }
}

// 8) 空头是镜像：入场在阻力下沿，止损在入场上方
{
  const s = mkSet([{ price: 101, strength: 80 }, { price: 96, strength: 80 }], 100, 1);
  const b = planBracket(s, 'short', {});
  if (!b) failures.push('空头：算不出来');
  else {
    if (b.entryKind !== 'level') failures.push('空头：该认出结构位入场，得到 ' + b.entryKind);
    if (Math.abs(b.entry - 100.85) > 1e-6) failures.push('空头：入场该是阻力下沿 100.85，得到 ' + b.entry);
    if (!(b.stop > b.entry && b.entry > b.target)) failures.push('空头：入场/止损/止盈的顺序不对');
    if (b.entryDistancePct <= 0) failures.push('空头：入场该高于现价，偏离算成 ' + b.entryDistancePct + '%');
  }
}

// 9) 硬规则：任意价格、方向、模式，止损永远在入场价的另一侧，盈亏比和两个距离自洽
{
  for (const last of [7, 50, 100, 5_000]) {
    for (const dir of ['long', 'short'] as const) {
      for (const mode of ['limit', 'market'] as const) {
        for (const levels of [
          [{ price: last * 0.99, strength: 80 }, { price: last * 1.04, strength: 80 }],
          [{ price: last * 0.98, strength: 20 }],
          [],
        ]) {
          const s = mkSet(levels, last, last * 0.01);
          const b = planBracket(s, dir, { entryMode: mode });
          const tag = `${dir}/${mode}/现价 ${last}/位 ${levels.length}`;
          if (!b) { failures.push('硬规则：算不出来 ' + tag); continue; }
          const ok = dir === 'long' ? (b.stop < b.entry && b.target > b.entry) : (b.stop > b.entry && b.target < b.entry);
          if (!ok) failures.push('硬规则：止损止盈站错边 ' + tag);
          const rr = Math.round((Math.abs(b.target - b.entry) / Math.abs(b.entry - b.stop)) * 100) / 100;
          if (Math.abs(rr - b.riskReward) > 0.02) failures.push('硬规则：盈亏比和两个价对不上 ' + tag + ' ' + rr + ' vs ' + b.riskReward);
          if (!(b.riskPct > 0)) failures.push('硬规则：风险百分比不是正数 ' + tag);
          if (mode === 'limit') {
            const okDir = dir === 'long' ? b.entry <= last : b.entry >= last;
            if (!okDir) failures.push('硬规则：限价挂到了现价的同一侧（会立刻成交）' + tag);
          }
        }
      }
    }
  }
}

// 10) 确定性：同样输入必须同样输出
{
  const s = mkSet([{ price: 99, strength: 80 }, { price: 104, strength: 80 }], 100, 1);
  if (JSON.stringify(planBracket(s, 'long', {})) !== JSON.stringify(planBracket(s, 'long', {}))) {
    failures.push('确定性：两次算出来的方案不同');
  }
}

if (failures.length === 0) console.log('  全部通过（确定性 / no-lookahead / 上下平衡 / 同带合并 / 回踩入场 / 贴身不挂 / 太远不等 / 超偏离上限退回现价 / 空头镜像 / 硬规则）');
else for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length === 0 ? 0 : 1);
