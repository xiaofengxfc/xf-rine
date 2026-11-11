/**
 * 本地数据层的自检。
 *
 * 这一段没有界面可点、也不连交易所，出问题的方式都是「悄悄算错」：
 * 时间单位判错会让整条时间轴跑到 2500 年、文件名大小写对不上会报「目录里没有这个文件」、
 * 坏行没清掉会让 ATR 变成 NaN。所以拿真文件跑一遍。
 *
 * 跑法：pnpm check:data
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { containedPath, readFile, scanDir, tfSeconds } from '../src/localdata.js';

const dir = resolve('.scratch/check-data');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

let fails = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { console.log('  ✓ ' + label); return; }
  fails += 1;
  console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
};

/** 造一份日线：随机游走，量都大于 0 */
function makeBars(n: number, start: number, base = 100) {
  let px = base;
  const rows: { time: number; open: number; high: number; low: number; close: number; tick_volume: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = Math.max(1, px + Math.sin(i / 7) * 1.2);
    rows.push({
      time: start + i * 86_400, open: o,
      high: Math.max(o, c) + 0.3, low: Math.min(o, c) - 0.3,
      close: c, tick_volume: 800 + (i % 17) * 30,
    });
    px = c;
  }
  return rows;
}

/** 列式写法：hyparquet-writer 要的是 { name, data } 列表 */
function writeParquet(path: string, rows: Record<string, number>[]) {
  const cols = Object.keys(rows[0]!);
  writeFileSync(path, Buffer.from(parquetWriteBuffer({
    columnData: cols.map((name) => ({ name, data: rows.map((r) => r[name]!) })),
  })));
}

const t0 = 1_600_000_000;
writeParquet(resolve(dir, 'BTCUSDT_D1.parquet'), makeBars(300, t0));
// 上游那份 A 股数据的口径：time = unix 秒 / 1000
// 上游 A 股那份的口径：2020 年 = 1_600_000（unix 秒 ÷ 1000）。起点取在 2020 年
writeParquet(resolve(dir, 'ASHARE_daily.parquet'), makeBars(120, 1_600_000_000, 12).map((r) => ({
  ...r, time: Math.round(r.time / 1000),
})));
// CSV 和 parquet 混放，且列名换成 volume（不是 tick_volume）
const csv = makeBars(60, 1_700_000_000, 50)
  .map((r) => [r.time, r.open.toFixed(2), r.high.toFixed(2), r.low.toFixed(2), r.close.toFixed(2), r.tick_volume].join(','))
  .join('\n');
writeFileSync(resolve(dir, 'ETHUSDT_H1.csv'), 'time,open,high,low,close,volume\n' + csv);
// 干扰文件：不是 K 线，不该被列进来
writeFileSync(resolve(dir, 'readme.txt'), 'not data');

console.log('目录枚举');
{
  const s = scanDir(dir);
  ok(s.files === 3, '只认 .parquet 和 .csv（readme.txt 不算）', '文件数 ' + s.files);
  const names = s.instruments.map((i) => i.symbol).sort();
  ok(JSON.stringify(names) === JSON.stringify(['ASHARE', 'BTCUSDT', 'ETHUSDT']), '三个品种都列出来了', JSON.stringify(names));
  const eth = s.instruments.find((i) => i.symbol === 'ETHUSDT');
  ok(eth?.timeframes.join() === 'H1', 'CSV 里的 H1 也认出来了', JSON.stringify(eth?.timeframes));
}

console.log('时间单位');
{
  const p = containedPath(dir, 'ASHARE', 'daily');
  const { bars } = await readFile(p);
  const y = new Date(bars[0]!.time * 1000).getUTCFullYear();
  // 1_600_000 当秒读会得到 1970 年附近；正确换算是 2020 年
  ok(y === 2020, '「秒÷1000」的口径按整列换算回 2020 年', '读到 ' + y + ' 年');
  ok(bars.every((b, i) => i === 0 || b.time > bars[i - 1]!.time), '时间严格递增');
}

console.log('列名与清洗');
{
  const { bars } = await readFile(containedPath(dir, 'ETHUSDT', 'H1'));
  ok(bars.length === 60, 'volume 列被当成量', '读到 ' + bars.length + ' 根');
  ok(bars.every((b) => b.volume > 0), '没有量为 0 的停牌行');
}

console.log('大小写与越界');
{
  // 枚举给的是真实文件名，查询方传来的大小写可能不一样
  ok(containedPath(dir, 'btcusdt', 'd1').endsWith('BTCUSDT_D1.parquet'), '品种名/周期大小写不敏感');
  let threw = '';
  try { containedPath(dir, '../etc', 'D1'); } catch (e) { threw = (e as Error).message; }
  ok(threw !== '', '带路径分隔符的品种名被拒', threw);
}

console.log('周期秒数');
{
  ok(tfSeconds('D1') === 86_400 && tfSeconds('H1') === 3600 && tfSeconds('15min') === 0,
    'D1/H1 有秒数，认不出的代号给 0（调用方自己决定怎么办）');
}

rmSync(dir, { recursive: true, force: true });
console.log('');
if (fails > 0) {
  console.log('本地数据自检：' + fails + ' 项没过');
  process.exit(1);
}
console.log('✓ 本地数据自检全部通过');
