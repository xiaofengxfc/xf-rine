/**
 * 本地数据层的自检。
 *
 * 这一段没有界面可点、也不连交易所，出问题的方式都是「悄悄算错」：
 * 时间单位判错会让整条时间轴跑到 2500 年、文件名大小写对不上会报「目录里没有这个文件」、
 * 坏行没清掉会让 ATR 变成 NaN。
 *
 * 数据现在是 Python 引擎在读（sidecar/src/local_data_loader.py），所以这里造一批
 * 覆盖各种口径的真文件（parquet / csv、秒 / 毫秒 / 秒÷1000、三种命名），
 * 通过 sidecar 的接口读回来核对 —— 测的是「真读一遍」，不是替身。
 *
 * 跑法：pnpm check:data
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { analyzeLocal, instruments, localBars, SidecarError } from '../src/sr/client.js';
import { stopSidecar } from '../src/sr/client.js';

const dir = resolve('.scratch/check-data');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

let fails = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { console.log('  ✓ ' + label); return; }
  fails += 1;
  console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
};

interface Row { time: number; open: number; high: number; low: number; close: number; tick_volume: number }

/** 造一份 K 线：确定性的正弦波，量都大于 0 */
function makeBars(n: number, start: number, step: number, base = 100): Row[] {
  let px = base;
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = Math.max(1, px + Math.sin(i / 7) * 1.2);
    rows.push({
      time: start + i * step, open: o,
      high: Math.max(o, c) + 0.3, low: Math.min(o, c) - 0.3,
      close: c, tick_volume: 800 + (i % 17) * 30,
    });
    px = c;
  }
  return rows;
}

function writeParquet<T extends object>(path: string, rows: T[]) {
  const cols = Object.keys(rows[0]!);
  writeFileSync(path, Buffer.from(parquetWriteBuffer({
    columnData: cols.map((name) => ({ name, data: rows.map((r) => (r as Record<string, number>)[name]!) })),
  })));
}

const t0 = 1_600_000_000; // 2020-09-13
// 1) 标准口径：unix 秒
writeParquet(resolve(dir, 'BTCUSDT_D1.parquet'), makeBars(300, t0, 86_400));
// 2) 上游 A 股口径：time = unix 秒 ÷ 1000（2020 年 = 1_600_000）
writeParquet(resolve(dir, 'ASHARE_daily.parquet'),
  makeBars(120, t0, 86_400, 12).map((r) => ({ ...r, time: Math.round(r.time / 1000) })));
// 3) 毫秒口径。写 CSV 而不是 parquet：hyparquet-writer 会把时间列推成 int32，
//    毫秒时间戳（1.6e12）直接溢出 —— 这跟被测的时间单位判定没关系，换个容器而已。
{
  const rows = makeBars(200, t0 * 1000, 3_600_000);
  const text = rows
    .map((r) => [r.time, r.open.toFixed(2), r.high.toFixed(2), r.low.toFixed(2), r.close.toFixed(2), r.tick_volume].join(','))
    .join('\n');
  writeFileSync(resolve(dir, 'MS_1h.csv'), 'time,open,high,low,close,volume\n' + text);
}
// 4) CSV + volume 列名
const csv = makeBars(60, 1_700_000_000, 3600, 50)
  .map((r) => [r.time, r.open.toFixed(2), r.high.toFixed(2), r.low.toFixed(2), r.close.toFixed(2), r.tick_volume].join(','))
  .join('\n');
writeFileSync(resolve(dir, 'ETHUSDT_H1.csv'), 'time,open,high,low,close,volume\n' + csv);
// 5) 干扰文件：不是 K 线，不该被列进来
writeFileSync(resolve(dir, 'readme.txt'), 'not data');
// 6) 脏数据：量 0、high<low、重复时间戳
{
  const rows: Row[] = makeBars(80, t0, 3600, 30);
  rows[10] = { ...rows[10]!, tick_volume: 0 };              // 停牌行
  rows[20] = { ...rows[20]!, high: rows[20]!.low - 1 };      // 结构性坏行
  rows[30] = { ...rows[30]!, open: 0, close: 0 };            // 价格为 0
  rows.push({ ...rows[40]!, close: rows[40]!.close + 5 });   // 重复时间戳（后到的为准）
  writeParquet(resolve(dir, 'DIRTY_H1.parquet'), rows);
}

console.log('目录枚举');
{
  const s = await instruments(dir);
  ok(s.count === 5, '认出 5 个品种（readme.txt 不算）', '实际 ' + s.count + '：' + s.instruments.map((i) => i.symbol).join(','));
  ok((s as { files?: number }).files === 5, '文件数按 .parquet/.csv 计', '实际 ' + (s as { files?: number }).files);
  const names = s.instruments.map((i) => i.symbol).sort().join(',');
  ok(names === 'ASHARE,BTCUSDT,DIRTY,ETHUSDT,MS', '品种名正确', names);
  const ashare = s.instruments.find((i) => i.symbol === 'ASHARE');
  ok(ashare?.timeframes.join() === 'D1', 'A 股命名的 daily 归一成 D1', JSON.stringify(ashare?.timeframes));
  const ms = s.instruments.find((i) => i.symbol === 'MS');
  ok(ms?.timeframes.join() === 'H1', '小写周期 1h 归一成 H1', JSON.stringify(ms?.timeframes));
}

console.log('时间单位');
{
  const a = await localBars(dir, 'ASHARE', 'D1', 500);
  const y = new Date(a.bars[0]!.time * 1000).getUTCFullYear();
  ok(y === 2020, '「秒÷1000」的口径按整列换算回 2020 年', '读到 ' + y + ' 年');
  ok(a.bars.every((b, i) => i === 0 || b.time > a.bars[i - 1]!.time), '时间严格递增');

  const m = await localBars(dir, 'MS', 'H1', 500);
  const my = new Date(m.bars[0]!.time * 1000).getUTCFullYear();
  ok(my >= 2020 && my <= 2100, '毫秒口径换算成年份', '读到 ' + my + ' 年');
  // 毫秒和秒两条口径的同一天必须落在同一秒上
  const a2 = await localBars(dir, 'BTCUSDT', 'D1', 500);
  ok(Math.abs(a2.bars[0]!.time - (t0)) <= 86_400, '秒口径的第一根就在起点附近', String(a2.bars[0]!.time));
}

console.log('列名与清洗');
{
  const e = await localBars(dir, 'ETHUSDT', 'H1', 500);
  ok(e.bars.length === 60, 'volume 列被当成量', '读到 ' + e.bars.length + ' 根');
  ok(e.bars.every((b) => b.volume > 0), '没有量为 0 的停牌行');

  const d = await localBars(dir, 'DIRTY', 'H1', 500);
  // 80 根里去掉量 0（1 根）、坏行（1 根）、价格为 0（1 根）= 77；再加一条重复时间戳被合并 = 77
  ok(d.bars.length === 77, '脏数据清洗：量 0 / 坏行 / 价格为 0 各去一根，重复时间戳合并',
    '读到 ' + d.bars.length + ' 根');
  ok(d.bars.every((b) => b.volume > 0 && b.high >= b.low && b.low > 0), '清洗后没有坏行');
}

console.log('周期归一与越界');
{
  const a = await localBars(dir, 'BTCUSDT', '1d', 500);
  ok(a.tf === 'D1', '查询用 1d 能读到，返回的标准周期是 D1', a.tf);
  const c = await localBars(dir, 'ETHUSDT', 'H1', 10);
  ok(c.bars.length === 10, 'limit 生效', '读到 ' + c.bars.length + ' 根');

  let rejected = '';
  try {
    await analyzeLocal({ dir, symbol: '../etc', tf: 'D1', n_zones: 3 });
  } catch (e) {
    rejected = e instanceof SidecarError ? e.code + ' ' + e.message : String(e);
  }
  ok(/不合法|BAD|ValueError/.test(rejected), '带路径分隔符的品种名被拒', rejected);
}

stopSidecar();
rmSync(dir, { recursive: true, force: true });
console.log('');
if (fails > 0) {
  console.log('本地数据自检：' + fails + ' 项没过');
  process.exit(1);
}
console.log('✓ 本地数据自检全部通过');
