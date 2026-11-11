/**
 * 命令行体检：按持仓成本推导止盈止损（planPositionBracket）。
 * 用法： pnpm -F server exec tsx scripts/check-position-plan.ts BTC_USDT 15m
 *
 * 主体用构造出来的位和价，不依赖网络：这一层的对错和行情无关，靠的是几条硬规矩 ——
 * 锚在成本、止损只能在现价另一侧、成本口径的风险不小于当前浮亏、破位要说破、不动输入。
 */
import { detectLevels, planPositionBracket, type Bar, type Level, type LevelSet } from '../src/levels.js';

const failures: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

function mkLevel(price: number, strength: number, last: number): Level {
  return {
    price,
    role: price <= last ? 'support' : 'resistance',
    strength,
    touches: 3,
    failures: 0,
    volumeRatio: 0.5,
    distancePct: 0,
    lastTouch: 1_700_000_000,
    zoneLow: price * 0.999,
    zoneHigh: price * 1.001,
  };
}

function mkSet(prices: [number, number][], atrValue: number, last: number): LevelSet {
  const levels = prices.map(([p, s]) => mkLevel(p, s, last));
  const supports = levels.filter((l) => l.role === 'support');
  const resistances = levels.filter((l) => l.role === 'resistance');
  return {
    levels,
    atr: atrValue,
    last,
    rangeHigh: Math.max(...levels.map((l) => l.price)),
    rangeLow: Math.min(...levels.map((l) => l.price)),
    nearestSupport: supports.length ? supports[supports.length - 1]! : null,
    nearestResistance: resistances.length ? resistances[0]! : null,
  };
}

// ---- 1) 浮亏 + 结构破了：止损会被推到破位之后，必须直说，不能悄悄放宽 ----
{
  const set = mkSet([[95, 50], [97, 60], [99, 40]], 1, 96);
  const plan = planPositionBracket(set, { direction: 'long', entry: 100, last: 96, mark: 96 });
  if (!plan) failures.push('破位：算不出方案');
  else {
    check(plan.entry === 100, '破位：锚点不是成本价，变成了 ' + plan.entry);
    check(plan.broken === true, '破位：跌破关键支撑 97 却没报 broken');
    check(plan.notes.length > 0, '破位：没有任何一句提醒');
    check(plan.stop < 96, '破位：止损 ' + plan.stop + ' 不在现价 96 下方，挂上去当场成交');
    check(plan.mountable.stop === true, '破位：止损明明挂得上，却报了挂不上');
    check(near(plan.riskPct, 5.3, 0.01), '破位：成本口径风险算错了，是 ' + plan.riskPct + '%');
    check(plan.tooWide === true, '破位：亏 5.3% 超过 4% 上限，却没报 tooWide');
    check(plan.acceptable === false, '破位：这一侧不该认为方案可用');
  }
}

// ---- 2) 浮盈 + 支撑抬到成本之上：止损锁住利润，盈亏比给 null 而不是编一个 ----
{
  const set = mkSet([[102, 60], [108, 50]], 1, 105);
  const plan = planPositionBracket(set, { direction: 'long', entry: 100, last: 105, mark: 105 });
  if (!plan) failures.push('保本：算不出方案');
  else {
    check(plan.locksProfit === true, '保本：止损已在成本上方，却没报 locksProfit');
    check(plan.riskFromEntry < 0, '保本：成本口径风险该是负数，得到 ' + plan.riskFromEntry);
    check(plan.riskReward === null, '保本：止损在成本上方时盈亏比该给 null，得到 ' + plan.riskReward);
    check(plan.acceptable === true, '保本：锁住利润的方案不该判成不可用');
    check(plan.tooWide === false, '保本：锁住利润不算风险过宽');
    check(near(plan.stop, 101.7, 0.001), '保本：止损该是支撑 102 下方一个缓冲，得到 ' + plan.stop);
    check(near(plan.target, 108), '保本：止盈该取现价上方最近的阻力 108，得到 ' + plan.target);
  }
}

// ---- 3) 空头镜像：方向搞反的话，止损和止盈会一起错 ----
{
  // 成本 100 已经在 98：上方最近的阻力 103 是止损，下方最近的支撑 97 是止盈
  const set = mkSet([[94, 50], [97, 60], [103, 50]], 1, 98);
  const plan = planPositionBracket(set, { direction: 'short', entry: 100, last: 98, mark: 98 });
  if (!plan) failures.push('空头：算不出方案');
  else {
    check(plan.entry === 100, '空头：锚点不是成本价');
    check(plan.stop > 103, '空头：止损 ' + plan.stop + ' 没放在上方最近的阻力 103 之外');
    check(plan.mountable.stop === true, '空头：止损挂不上？');
    check(near(plan.target, 97), '空头：止盈该取现价下方最近的支撑 97，得到 ' + plan.target);
    check(plan.riskPct > 0, '空头：空头亏钱时成本口径风险必须是正数');
    check(plan.locksProfit === false, '空头：止损在成本上方，这里不该判成锁利');
  }
}

// ---- 3b) 空头浮亏 + 破位：最近的位还在成本上方，止盈也要如实说是亏着走 ----
{
  const set = mkSet([[94, 50], [103, 60], [105, 50]], 1, 104);
  const plan = planPositionBracket(set, { direction: 'short', entry: 100, last: 104, mark: 104 });
  if (!plan) failures.push('空头破位：算不出方案');
  else {
    check(plan.broken === true, '空头破位：涨破关键阻力 103 却没报 broken');
    check(plan.rewardFromEntry < 0, '空头破位：最近的位在成本上方，收益该是负的，得到 ' + plan.rewardFromEntry);
    check(plan.notes.some((n) => n.includes('带着亏损离场')), '空头破位：没说清这个止盈是亏着走');
    check(plan.acceptable === false, '空头破位：不该认为方案可用');
  }
}

// ---- 3c) 价格正好踩在位上：不算破位 ----
{
  const set = mkSet([[97, 60], [104, 50]], 1, 97);
  const plan = planPositionBracket(set, { direction: 'long', entry: 100, last: 97, mark: 97 });
  if (!plan) failures.push('踩位：算不出方案');
  else check(plan.broken === false, '踩位：价格正好在支撑 97 上就报了破位，太敏感');
}

// ---- 4) 一个位都没有：止损止盈都按波动率兜底，并且明说不是结构位 ----
{
  const set = mkSet([], 1, 100);
  const plan = planPositionBracket(set, { direction: 'long', entry: 100, last: 100, mark: 100 });
  if (!plan) failures.push('兜底：算不出方案');
  else {
    check(near(plan.stop, 98.5), '兜底：止损该是现价下方 1.5 ATR，得到 ' + plan.stop);
    check(near(plan.target, 102.5), '兜底：止盈该是成本上方 2.5 ATR，得到 ' + plan.target);
    check(plan.stopSource.includes('ATR'), '兜底：止损来源没说明是 ATR');
    check(plan.targetSource.includes('ATR'), '兜底：止盈来源没说明是 ATR');
    check(plan.notes.length >= 2, '兜底：两处都该有提示');
  }
}

// ---- 5) 硬规矩：止损永远在现价另一侧；成本口径风险不小于当前浮亏；不动输入 ----
{
  const set = mkSet([[90, 40], [94, 55], [97, 45], [103, 50], [106, 60], [110, 40]], 1.2, 100);
  const snapshot = JSON.stringify(set);
  for (const last of [92, 96, 99, 101, 104, 108]) {
    for (const dir of ['long', 'short'] as const) {
      const plan = planPositionBracket(set, { direction: dir, entry: 100, last, mark: last });
      if (!plan) { failures.push('硬规矩：' + dir + ' @' + last + ' 算不出方案'); continue; }
      check(plan.mountable.stop, '硬规矩：' + dir + ' @' + last + ' 的止损挂在现价同一侧');
      // 止损只能挂在现价更差的一侧，所以成本口径的风险不可能小于当前浮亏
      const floating = dir === 'long' ? 100 - last : last - 100;
      if (plan.riskFromEntry > 0 && plan.riskFromEntry + 1e-9 < floating) {
        failures.push('硬规矩：' + dir + ' @' + last + ' 的成本口径风险 ' + plan.riskFromEntry.toFixed(2)
          + ' 小于当前浮亏 ' + floating.toFixed(2) + ' —— 数字自相矛盾');
      }
    }
  }
  check(JSON.stringify(set) === snapshot, '副作用：算方案把输入的结构集合改了');
}

// ---- 6) 确定性：同样输入两遍必须一模一样 ----
{
  const set = mkSet([[95, 50], [97, 60], [105, 55]], 1, 100);
  const a = JSON.stringify(planPositionBracket(set, { direction: 'long', entry: 99, last: 100, mark: 100 }));
  const b = JSON.stringify(planPositionBracket(set, { direction: 'long', entry: 99, last: 100, mark: 100 }));
  check(a === b, '确定性：两次调用结果不同');
}

console.log('自检（构造数据）：');
if (failures.length === 0) {
  console.log('  全部通过（破位报警 / 保本 / 空头镜像 / ATR 兜底 / 止损方向 / 风险不小于浮亏 / 无副作用 / 确定性）');
} else {
  for (const f of failures) console.log('  ✗ ' + f);
}

// ---- 7) 真实数据跑一遍：只看算不算得出来、方向对不对（没有网络就跳过） ----
const contract = process.argv[2] ?? 'BTC_USDT';
const interval = process.argv[3] ?? '15m';
try {
  const res = await fetch(
    'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=' + contract
      + '&interval=' + interval + '&limit=500',
  );
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const raw = (await res.json()) as { t: number; o: string; h: string; l: string; c: string; v: number }[];
  const all: Bar[] = raw.map((c) => ({
    time: Number(c.t), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v),
  }));
  const closed = all.slice(0, -1);
  const live = all[all.length - 1]!.close;
  const set = detectLevels(closed, {});
  console.log('');
  console.log(contract + ' ' + interval + '  现价 ' + live + '  ATR14 ' + set.atr.toFixed(4)
    + '（' + ((set.atr / live) * 100).toFixed(2) + '%）');
  for (const entryPct of [-1.5, 1.5]) {
    const entry = live * (1 + entryPct / 100);
    for (const dir of ['long', 'short'] as const) {
      const plan = planPositionBracket({ ...set, last: live }, { direction: dir, entry, last: live, mark: live });
      if (!plan) { console.log('  ' + dir + ' 成本 ' + entry.toFixed(4) + '：算不出来'); continue; }
      console.log(
        '  ' + (dir === 'long' ? '多' : '空') + ' 成本 ' + entry.toFixed(4)
        + ' → 止损 ' + plan.stop.toFixed(4) + '（成本口径 ' + plan.riskPct + '%）'
        + ' 止盈 ' + plan.target.toFixed(4) + '（' + plan.rewardPct + '%）'
        + ' 盈亏比 ' + (plan.riskReward === null ? '保本' : plan.riskReward)
        + (plan.broken ? '  ← 已破位' : '') + (plan.tooWide ? '  ← 风险过宽' : ''),
      );
      check(plan.mountable.stop, '真实数据：' + dir + ' 的止损挂在现价同一侧');
    }
  }
} catch (e) {
  console.log('');
  console.log('（没有网络，跳过真实数据那一段：' + (e as Error).message + '）');
}

if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
}
process.exit(failures.length === 0 ? 0 : 1);
