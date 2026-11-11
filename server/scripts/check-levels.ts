/**
 * 命令行体检：拉真实 K 线，跑一遍支撑阻力检测，把结果打到终端，再跑一组自检。
 * 用法： pnpm -F server exec tsx scripts/check-levels.ts BTC_USDT 15m
 *
 * 算法移植自 rosemarycox5334-debug/Detect_support_and_resistance_levels 的 V3Fusion，
 * 所以自检的重点也放在那套东西的几条硬性质上：体积守恒、区宽夹逼、间距、因果性。
 */
import {
  atrSeries, decayWeights, detectLevels, makeBins, volumeProfile, wilsonLower, zigzag,
  type Bar,
} from '../src/levels.js';

const contract = process.argv[2] ?? 'BTC_USDT';
const interval = process.argv[3] ?? '15m';

interface GateCandle { t: number; o: string; h: string; l: string; c: string; v: number }

const res = await fetch(
  'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=' + contract + '&interval=' + interval + '&limit=500',
);
if (!res.ok) {
  console.error('拉数据失败', res.status, await res.text());
  process.exit(1);
}
const raw = (await res.json()) as GateCandle[];
const allBars: Bar[] = raw.map((c) => ({
  time: Number(c.t), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v),
}));
const closed = allBars.slice(0, -1);
const live = allBars[allBars.length - 1]!.close;

const set = detectLevels(closed, {});
// 距离按「现价」重算：检测器只看到已收盘的 K 线，它嘴里的 last 是上一根收盘价。
// 角色也跟着重算 —— 现价穿过一条位之后，头顶的阻力就变成脚下的支撑。
const A = set.atr > 0 ? set.atr : 1;
const levels = set.levels.map((l) => ({
  ...l,
  distancePct: ((l.price - live) / live) * 100,
  distAtr: (l.price - live) / A,
  role: (l.zoneHigh < live ? 'support' : l.zoneLow > live ? 'resistance' : l.price <= live ? 'support' : 'resistance') as 'support' | 'resistance',
}));
console.log('');
console.log(contract + ' ' + interval + '  用了 ' + closed.length + ' 根已收盘 K 线，现价 ' + live + '，已确认枢轴 ' + set.pivots + ' 根');
console.log('ATR14 = ' + set.atr.toFixed(4) + '（' + ((set.atr / live) * 100).toFixed(2) + '%），回看 ' + set.lookback + ' 根，区间 ' + set.rangeLow + ' - ' + set.rangeHigh);
console.log('');
console.log('  中枢        角色  分数  守住率  触及/守住  区宽    距现价     停滞');
for (const lv of levels) {
  const price = lv.price.toFixed(lv.price >= 1000 ? 1 : 5).padStart(10);
  console.log(
    price + '  ' + (lv.role === 'support' ? '支撑' : '阻力') +
    '  ' + lv.score.toFixed(2).padStart(5) +
    '  ' + (lv.holdRate * 100).toFixed(0).padStart(4) + '%' +
    '  ' + String(lv.touches).padStart(3) + '/' + String(lv.holds).padStart(3) +
    '  ' + lv.widthAtr.toFixed(2).padStart(5) + 'A' +
    '  ' + (lv.distancePct >= 0 ? '+' : '') + lv.distancePct.toFixed(2) + '%' +
    '  ' + lv.pStall.toFixed(2),
  );
}
if (levels.length === 0) console.log('  （没有位通过筛选）');

// ---- 自检 ----
console.log('');
console.log('自检：');
const failures: string[] = [];

// 1) 确定性：同样输入必须同样输出
if (JSON.stringify(detectLevels(closed, {})) !== JSON.stringify(detectLevels(closed.map((b) => ({ ...b })), {}))) {
  failures.push('确定性：两次结果不同');
}

// 2) 因果性：把序列截到 t 再跑 ZigZag，confirmIdx <= t 的枢轴必须和整条序列完全一致。
//    对得上就说明「在 t 时刻实时算」和「事后算」看到的枢轴是同一批，没有偷看未来。
{
  const full = zigzag(closed, atrSeries(closed));
  const cut = Math.floor(closed.length * 0.7);
  const part = zigzag(closed.slice(0, cut), atrSeries(closed.slice(0, cut)));
  const pick = (zz: typeof full, upto: number) => {
    const out: string[] = [];
    for (let i = 0; i < zz.idx.length; i++) {
      if (zz.confirmIdx[i]! <= upto) out.push(zz.idx[i] + ':' + zz.price[i] + ':' + zz.kind[i]);
    }
    return out.join('|');
  };
  if (pick(full, cut - 1) !== pick(part, cut - 1)) failures.push('因果性：截断序列看到的枢轴和整条序列不一致（用了未来数据）');
  if (full.idx.length === 0) failures.push('因果性：整条序列一根枢轴都没有，测试本身失效');
}

// 3) 体积守恒：剖面的总量必须等于喂进去的权重总量（旧做法会放大十几倍）
{
  const b = makeBins(100, 200, 0.5);
  const h = [150, 180, 160, 190];
  const l = [120, 140, 100, 150];
  const w = [10, 20, 30, 40];
  const prof = volumeProfile(h, l, w, b);
  const sum = prof.reduce((a, x) => a + x, 0);
  const want = w.reduce((a, x) => a + x, 0);
  if (Math.abs(sum - want) > 1e-6) failures.push('体积守恒：剖面总量 ' + sum.toFixed(3) + ' ≠ 权重总量 ' + want);
  // 时间衰减：最新一根权重 1，半衰期那根权重 0.5
  const dw = decayWeights(121, 60);
  if (Math.abs(dw[120]! - 1) > 1e-9) failures.push('时间衰减：最新一根权重不是 1');
  if (Math.abs(dw[60]! - 0.5) > 0.01) failures.push('时间衰减：半衰期处的权重不是 0.5，得到 ' + dw[60]);
}

// 4) 区宽夹逼：不能靠「给一个超宽的区」去刷守住率
for (const lv of levels) {
  if (lv.widthAtr < 0.3 - 1e-6 || lv.widthAtr > 1.2 + 1e-6) failures.push('区宽夹逼：' + lv.price + ' 的区宽 ' + lv.widthAtr.toFixed(2) + ' ATR 越界');
}

// 5) 间距：NMS 之后任意两条位之间不能小于 0.9 ATR
{
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.price - sorted[i - 1]!.price;
    if (gap < set.atr * 0.9 - 1e-6) failures.push('间距：' + sorted[i - 1]!.price + ' 与 ' + sorted[i]!.price + ' 相距不到 0.9 ATR');
  }
}

// 6) 方向自洽：支撑不能整个跑到现价上方，阻力不能整个跑到下方
for (const lv of levels) {
  if (lv.role === 'support' && lv.price > live) failures.push('方向：支撑 ' + lv.price + ' 的中枢在现价 ' + live + ' 上方');
  if (lv.role === 'resistance' && lv.price < live) failures.push('方向：阻力 ' + lv.price + ' 的中枢在现价 ' + live + ' 下方');
  if (lv.holds > lv.touches) failures.push('计数：守住次数大于触及次数 ' + lv.price);
  if (lv.holdRate < 0 || lv.holdRate > 1) failures.push('守住率越界 ' + lv.price);
  if (Math.abs(lv.distAtr - (lv.price - live) / A) > 1e-6) failures.push('距离口径不一致 ' + lv.price);
}

// 7) Wilson 下界必须低于点估计（样本越多越接近）
{
  const lb = wilsonLower(7, 10);
  if (!(lb > 0 && lb < 0.7)) failures.push('Wilson：10 次守住 7 次的下界该在 (0,0.7)，得到 ' + lb.toFixed(3));
  if (!(wilsonLower(0, 5) === 0)) failures.push('Wilson：0 次守住的下界该是 0');
  if (!(wilsonLower(70, 100) > lb)) failures.push('Wilson：样本更多时下界没有收紧');
}

// 8) 数据不足不能抛异常，只能返回空集
{
  const tiny = detectLevels(closed.slice(0, 20), {});
  if (tiny.levels.length !== 0) failures.push('少数据：20 根 bar 也给出了位');
}

if (failures.length === 0) {
  console.log('  全部通过（确定性 / 因果性 / 体积守恒 / 区宽夹逼 / 间距 / 方向自洽 / Wilson / 少数据）');
} else {
  for (const f of failures) console.log('  ✗ ' + f);
}
process.exit(failures.length === 0 ? 0 : 1);
