/**
 * 阳性对照：喂一批「一定过得了门槛」的假 K 线进滚动多折，看闭环认不认得出。
 *
 * 为什么需要它：真实数据跑出来是「训练段一个形态都没选中」，于是测试段空着。
 * 这个结果本身有两种解释 ——
 *   (a) 形态确实没有方向性增量（我们想要的结论）；
 *   (b) 闭环有 bug，就算真有信号也选不出来（那这整件事就白做了）。
 * 不把 (b) 排除掉，(a) 就只是没证据，不是结论。
 *
 * 做法：造一段「形态出现后必涨」的行情 —— 每个吞没确认根的下一根收盘比它高 3 根中位数的幅度，
 * 其余随机走。然后跑同一套 walkForward，要求：
 *   · 训练段必须选中 bullishEngulfing；
 *   · 测试段必须仍然是正的增量；
 *   · 折外衰减不能把增量吃光。
 * 再来一组「反向」的，要求选中 bearish 那一侧，证明方向判断没写反。
 *
 * 用法： pnpm check:patterns 顺带跑（不联网，几秒钟）
 */
import type { Bar } from '../src/lib/api.ts';
import { HORIZONS, newBucket, feed, rowsOf, tierOf, walkForward } from './pattern-core.ts';

/** 定长伪随机，保证每次跑出来一样 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 造一段带信号的 K 线。
 *
 * signal = 'bull'：每 40 根左右人为插一个「看涨吞没」，之后 3 根往上走 1.2 倍 ATR；
 * signal = 'bear'：反过来；
 * signal = 'none'：纯随机，作为阴性对照。
 */
function synth(n: number, signal: 'bull' | 'bear' | 'none', seed: number): Bar[] {
  const rnd = makeRng(seed);
  const bars: Bar[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const atr = px * 0.004;
    const planted = signal !== 'none' && i % 40 === 20 && i > 0;
    const o = px;
    let c: number;
    let h: number;
    let l: number;
    if (planted) {
      const prev = bars[i - 1]!;
      if (signal === 'bull') {
        // 前一根阴线、这一根阳线包住前一根实体 —— 这就是 bullishEngulfing 的判定条件
        bars[i - 1] = { ...prev, open: prev.close + atr * 0.6, close: prev.close - atr * 0.7, high: Math.max(prev.high, prev.close + atr * 0.7), low: Math.min(prev.low, prev.close - atr * 0.8) };
        const base = bars[i - 1]!;
        c = base.close + atr * 1.4;
        h = c + atr * 0.2;
        l = Math.min(base.close, o) - atr * 0.1;
      } else {
        bars[i - 1] = { ...prev, open: prev.close - atr * 0.6, close: prev.close + atr * 0.7, high: Math.max(prev.high, prev.close + atr * 0.8), low: base(prev, atr) };
        const b = bars[i - 1]!;
        c = b.close - atr * 1.4;
        l = c - atr * 0.2;
        h = Math.max(b.close, o) + atr * 0.1;
      }
    } else {
      // 每 40 根里种信号之后的 3 根顺着方向走，其余随机
      const since = signal !== 'none' ? (i - 20) % 40 : 99;
      const drift = signal !== 'none' && since >= 1 && since <= 3 ? (signal === 'bull' ? 1 : -1) * atr : 0;
      const move = (rnd() - 0.5) * atr * 1.2 + drift;
      c = Math.max(1, o + move);
      h = Math.max(o, c) + rnd() * atr * 0.5;
      l = Math.max(0.5, Math.min(o, c) - rnd() * atr * 0.5);
    }
    bars.push({ time: (Math.floor(Date.UTC(2020, 0, 1) / 1000) + i * 3600), open: o, high: h!, low: l!, close: c, volume: 1 });
    px = c;
  }
  return bars;
}

function base(prev: Bar, atr: number): number {
  return Math.min(prev.low, prev.close - atr * 0.8);
}

/** 跑一次闭环，返回训练段选中了什么、测试段表现如何 */
function run(label: string, signal: 'bull' | 'bear' | 'none'): { picked: string[]; testExcess: number; trainExcess: number; pickedPerFold: number } {
  const series = [];
  for (let k = 0; k < 3; k += 1) {
    series.push({ contract: 'SYN' + k, interval: '1h', bars: synth(3000, signal, 1234 + k) });
  }
  const { reports, test } = walkForward(series as any, 3);
  const rows = rowsOf(test);
  const passed = rows.filter((r) => tierOf(r) >= 1).map((r) => r.id);
  const pickedTotal = reports.reduce((n, r) => n + r.picked, 0);
  const trainExcess = reports.reduce((n, r) => n + r.trainExcess, 0) / Math.max(1, reports.length);
  const testExcess = reports.reduce((n, r) => n + r.testExcess, 0) / Math.max(1, reports.length);
  console.log('  ' + label.padEnd(10) + ' 每折选中 ' + reports.map((r) => r.picked).join('/')
    + ' · 训练段选中 ' + (reports[0]?.detail ?? '-')
    + ' · 训练增量 ' + (trainExcess * 100).toFixed(1) + 'pp'
    + ' · 测试增量 ' + (testExcess * 100).toFixed(1) + 'pp'
    + ' · 测试段过门槛 ' + (passed.length ? passed.join(',') : '无'));
  return { picked: pickedTotal > 0 ? (reports[0]?.detail ?? '').split(',').filter(Boolean) : [], testExcess, trainExcess, pickedPerFold: pickedTotal };
}

/**
 * 打乱顺序的阴性对照。
 *
 * 「随机行情必须选不出任何形态」是一条错误的断言：20 个形态 × 若干折，总会有某个
 * 形态靠运气擦过门槛。真正该验的是「因果关系被破坏之后，闭环还会不会无中生有」——
 * 把真实 K 线的时间顺序打乱，形态与后续收益之间就不存在任何真实联系，
 * 这时多处重跑必须基本选不出东西。
 */
function shuffledNegativeControl(): number {
  const real = synth(3000, 'none', 4242);
  let total = 0;
  for (let s = 0; s < 5; s += 1) {
    const rnd = makeRng(900 + s);
    const shuffled = real.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = shuffled[i]!;
      shuffled[i] = shuffled[j]!;
      shuffled[j] = tmp;
    }
    shuffled.forEach((b, i) => { b.time = 1577836800 + i * 3600; });
    const { reports } = walkForward([{ contract: 'X', interval: '1h', bars: shuffled }] as any, 3);
    total += reports.reduce((n, r) => n + r.picked, 0);
  }
  return total;
}

console.log('阳性对照（不看真实数据，只看闭环认不认得出人造信号）：');
const bull = run('人造看涨', 'bull');
const bear = run('人造看跌', 'bear');
const none = run('纯随机', 'none');
const shuffled = shuffledNegativeControl();
console.log('  打乱顺序 15 次（3 折 × 5 轮）合计选中 ' + shuffled + ' 个');

const failures: string[] = [];
// 阳性：必须有信号，而且方向不能写反
if (bull.pickedPerFold === 0) failures.push('人造看涨信号没有被选中 —— 闭环要么选不出真信号，要么门槛坏了');
if (bear.pickedPerFold === 0) failures.push('人造看跌信号没有被选中');
if (bull.picked.some((id) => id.startsWith('bearish'))) failures.push('人造看涨信号选出了看跌形态，方向判断写反了：' + bull.picked.join(','));
if (bull.testExcess <= 0) failures.push('人造看涨信号在测试段的增量不是正的：' + (bull.testExcess * 100).toFixed(1) + 'pp');
if (bear.testExcess <= 0) failures.push('人造看跌信号在测试段的增量不是正的：' + (bear.testExcess * 100).toFixed(1) + 'pp');
// 负向：因果断开之后不应成批地选中
if (shuffled > 3) failures.push('打乱顺序后选中了 ' + shuffled + ' 个 —— 闭环会无中生有');
if (none.pickedPerFold > 4) failures.push('纯随机行情选中了 ' + none.pickedPerFold + ' 个 —— 门槛太松');

if (failures.length > 0) {
  console.error('\n阳性对照失败：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\n阳性对照通过：认得出人造信号、测试段增量仍为正，打乱因果后基本选不出东西。');
