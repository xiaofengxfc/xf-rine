/**
 * 本地 K 线数据源（移植上游项目的数据层）。
 *
 * 上游读的是本地 Parquet：一个文件夹里放一堆 .parquet，文件名里带品种和周期
 * （EURUSD_D1.parquet / 螺纹钢主连_H1.parquet / 000001_daily.parquet），
 * 列是 time(open/high/low/close/tick_volume)。这条路对「自己攒了一批历史数据、
 * 想离线算位」的人好用，所以照搬过来：目录、命名、列名三条约定一致。
 *
 * 和上游的差别，都是有原因的：
 *
 *   1. **不强制 Parquet。** 上游靠 pyarrow 读，我们靠 hyparquet（纯 JS，能打进桌面端）。
 *      但很多人手上是 CSV，所以 .csv 也认，列名一样就行。
 *   2. **不做复权。** 上游那套（data/adj_factors.parquet + heuristic 兜底）是为 A 股除权
 *      设计的，加密永续没有除权这回事。真拿这个目录去读 A 股 CSV，价格断层会原样进来 ——
 *      这一点写在 README 里，不静默猜。
 *   3. **目录只认你显式选的那个。** 上游 /api/data_dir 可以把任意路径写进去，
 *      在桌面端那等于给网页开了个任意读文件的口子。这里记住的路径必须落在
 *      配置里 XFRINE_DATA_DIR_ALLOW 给的根目录下（没配就是「当前选中的那个」），
 *      而且接口要过 requireLocal。见 routes.ts 的 /data/*。
 *
 * 时间口径：上游 A 股那份的 time 单位是「unix 秒 / 1000」（量化步长 1000 秒），
 * 期货/MT5 和我们的 K 线是「unix 秒」，有的导出工具给毫秒。这里一律按量级猜：
 * 大于 1e11 当毫秒，大于 1e9 当秒，更小的按上游的 /1000 口径乘回去。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

/** 一条 K 线。和服务端别处用的是同一个形状 */
export interface DataBar {
  time: number;   // unix 秒
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Instrument {
  /** 品种名，取自文件名（EURUSD / 螺纹钢主连 / 000001） */
  symbol: string;
  /** 这个品种有的周期，如 ['D1', 'H1'] */
  timeframes: string[];
}

export class DataError extends Error {
  status: number;
  label: string;
  constructor(status: number, label: string, message: string) {
    super(message);
    this.status = status;
    this.label = label;
  }
}

/** 认得的周期代号。上游三种命名约定合在一起 */
const TF_ALIASES: Record<string, string> = {
  daily: 'D1', '1d': 'D1', d1: 'D1',
  '60min': 'H1', h1: 'H1',
  m15: 'M15', '15min': 'M15', '15m': 'M15',
  m5: 'M5', '5min': 'M5', '5m': 'M5',
  w1: 'W1', weekly: 'W1',
  m1: 'M1', m3: 'M3', m30: 'M30', h4: 'H4', '4h': 'H4', h2: 'H2', h6: 'H6', h8: 'H8', h12: 'H12',
};

/** 文件名 -> {symbol, tf}。认 xxx_TF.ext；认不出来返回 null（不是错误，目录里可能有别的文件） */
function parseName(file: string): { symbol: string; tf: string } | null {
  const ext = extname(file).toLowerCase();
  if (ext !== '.parquet' && ext !== '.csv') return null;
  const stem = basename(file, ext);
  const cut = stem.lastIndexOf('_');
  if (cut <= 0) return null;
  const tfRaw = stem.slice(cut + 1).toLowerCase();
  const tf = TF_ALIASES[tfRaw];
  if (!tf) return null;
  return { symbol: stem.slice(0, cut), tf };
}


/**
 * 时间列换算成 unix 秒。
 *
 * 上游那份 A 股数据的 time 是「unix 秒 / 1000」—— 直接当秒用会得到 1970 年。
 * 量级判据：> 1e11 是毫秒，> 1e9（约 2001 年以后）是秒，再小就是上游那个 /1000 口径。
 */
function toUnixSec(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v > 1e11) return Math.round(v / 1000);
  if (v > 1e9) return Math.round(v);
  return Math.round(v * 1000);
}

/**
 * 整列一起判「这一列的时间是哪种单位」，而不是逐行猜。
 *
 * 逐行猜会出大错：上游那份 A 股数据的 time 是「unix 秒 / 1000」（例如 1600000 = 2020 年），
 * 但个别行的值可能大于 1e9，于是同一列里前一半被乘 1000、后一半被当秒 —— 时间轴直接崩掉。
 * 按中位数量级判一次，整列同口径，才不会自相矛盾。
 */
function timeScale(values: number[]): 'ms' | 'sec' | 'sec_div_1000' {
  const mid = medianOf(values.filter((v) => Number.isFinite(v) && v > 0));
  if (!(mid > 0)) return 'sec';
  // 毫秒：1e12 是 2001 年以后的毫秒。秒和「毫秒级」差三个数量级，不会认错
  if (mid > 1e12) return 'ms';
  // 秒：2001 年以后、且没到毫秒量级。加密永续的 K 线永远落在这里
  if (mid > 1e9) return 'sec';
  // 剩下的是上游那套「unix 秒 / 1000」（2020 年 = 1600000）。
  // 乘回去之后正好压在 1e9 上的是 2001-09-09 之前，早于本项目关心的任何行情；
  // 真正需要区分的是「毫秒但只到 1e10~1e11」这种少见写法 —— 上一档已经兜住。
  return 'sec_div_1000';
}

function medianOf(x: number[]): number {
  if (x.length === 0) return 0;
  const s = [...x].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function applyScale(v: number, scale: 'ms' | 'sec' | 'sec_div_1000'): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (scale === 'ms') return Math.round(v / 1000);
  if (scale === 'sec') return Math.round(v);
  return Math.round(v * 1000);
}

/** 从各种「时间」类型里取出数字。Parquet 里常见 Date 对象和 BigInt */
function numTime(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t / 1000;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : NaN; }
  return NaN;
};

/** 列名归一：tick_volume 当 volume，Pandas 导出的大写列也认 */
function pick(row: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (n in row) return row[n];
    const up = n.toUpperCase();
    if (up in row) return row[up];
  }
  return undefined;
}

/** 把一批原始行清洗成 K 线：去空、去停牌（量<=0）、去结构性坏行、按时间去重排序 */
function clean(rows: Record<string, unknown>[]): DataBar[] {
  const out: DataBar[] = [];
  // 时间单位按整列判一次，见 timeScale 的说明
  const scale = timeScale(rows.map((r) => numTime(pick(r, ['time', 'date', 'datetime', 'ts']))));
  for (const r of rows) {
    const t = applyScale(numTime(pick(r, ['time', 'date', 'datetime', 'ts'])), scale);
    const o = num(pick(r, ['open']));
    const h = num(pick(r, ['high']));
    const l = num(pick(r, ['low']));
    const c = num(pick(r, ['close']));
    const v = num(pick(r, ['volume', 'tick_volume', 'vol']));
    if (!(t > 0) || ![o, h, l, c, v].every(Number.isFinite)) continue;
    if (v <= 0) continue;                                  // 停牌
    if (h < l || h < o || h < c || l > o || l > c || l <= 0) continue; // 结构性坏行
    out.push({ time: t, open: o, high: h, low: l, close: c, volume: v });
  }
  out.sort((a, b) => a.time - b.time);
  const dedup: DataBar[] = [];
  for (const b of out) {
    if (dedup.length && dedup[dedup.length - 1]!.time === b.time) dedup[dedup.length - 1] = b;
    else dedup.push(b);
  }
  return dedup;
}

/** 读一个 CSV。只做最朴素的引号处理 —— 用来读 K 线够用了 */
function readCsv(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter((x) => x.trim());
  if (lines.length < 2) return [];
  const head = lines[0]!.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (cells.length < head.length) continue;
    const r: Record<string, unknown> = {};
    for (let k = 0; k < head.length; k++) r[head[k]!] = cells[k];
    rows.push(r);
  }
  return rows;
}

/**
 * 读一个文件成 K 线。Parquet 走 hyparquet，CSV 走手写解析。
 *
 * 文件名里的周期决定「时间戳怎么对齐」：日线按自然日去重（同一交易日多条只留最后一条），
 * 其它周期只按时间戳去重 —— 上游 data.ashare_load 是这么做的，照抄。
 */
export async function readFile(path: string): Promise<{ bars: DataBar[]; symbol: string; tf: string }> {
  const meta = parseName(basename(path));
  if (!meta) throw new DataError(400, 'BAD_NAME', '文件名要写成「品种_周期.parquet」，例如 EURUSD_H1.parquet');
  // 调用方传来的是目录枚举给出的 tf；万一和文件名对不上，以文件名为准
  if (!existsSync(path)) throw new DataError(404, 'NOT_FOUND', '文件不在了：' + basename(path));
  const ext = extname(path).toLowerCase();

  let rows: Record<string, unknown>[];
  try {
    if (ext === '.csv') rows = readCsv(path);
    else {
      const buf = readFileSync(path);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      rows = await parquetReadObjects({ file: ab, compressors });
    }
  } catch (e) {
    throw new DataError(400, 'READ_FAIL', '读不了 ' + basename(path) + '：' + (e as Error).message);
  }

  let bars = clean(rows as unknown as Record<string, unknown>[]);
  if (meta.tf === 'D1') {
    // 日线按自然日归一：同一交易日的多条只留最后一条
    const byDay = new Map<number, DataBar>();
    for (const b of bars) {
      const day = Math.floor(b.time / 86_400) * 86_400;
      byDay.set(day, { ...b, time: day });
    }
    bars = [...byDay.values()].sort((a, b) => a.time - b.time);
  }
  if (bars.length === 0) throw new DataError(422, 'EMPTY', basename(path) + ' 里没有能用的 K 线（列名要 time/open/high/low/close/volume）');
  return { bars, symbol: meta.symbol, tf: meta.tf };
}

/** 周期 -> 一根多少秒。日线用 86400（交易日历的空档由数据自己表现，这里不改） */
const TF_SECONDS: Record<string, number> = {
  M1: 60, M3: 180, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H2: 7200, H4: 14_400, H6: 21_600, H8: 28_800, H12: 43_200,
  D1: 86_400, W1: 604_800,
};

export function tfSeconds(tf: string): number {
  return TF_SECONDS[tf] ?? 0;
}

/**
 * 扫一个目录，列出品种和各自有的周期。不递归，只认 .parquet/.csv。
 *
 * 认不出周期的文件名（比如 000001_daily.parquet 里的 daily）不丢掉：它照样算一个品种、
 * 一个周期。上游 review 的结论是「认不出来就别列」更糟 —— 用户会以为文件没读到，
 * 而实际上只是周期代号不在我们的小表里。
 */
export function scanDir(dir: string): { dir: string; instruments: Instrument[]; files: number } {
  if (!dir) throw new DataError(400, 'NO_DIR', '还没选数据目录');
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new DataError(404, 'NO_DIR', '这个目录不存在：' + abs);
  }
  const map = new Map<string, Set<string>>();
  let files = 0;
  for (const name of readdirSync(abs)) {
    const ext = extname(name).toLowerCase();
    if (ext !== '.parquet' && ext !== '.csv') continue;
    files++;
    const m = parseName(name);
    const stem = basename(name, ext);
    const cut = stem.lastIndexOf('_');
    const symbol = m ? m.symbol : (cut > 0 ? stem.slice(0, cut) : stem);
    const tf = m ? m.tf : (cut > 0 ? stem.slice(cut + 1).toUpperCase() : 'D1');
    if (!map.has(symbol)) map.set(symbol, new Set());
    map.get(symbol)!.add(tf);
  }
  const order = Object.keys(TF_SECONDS);
  const instruments = [...map.entries()]
    .map(([symbol, tfs]) => ({
      symbol,
      timeframes: [...tfs].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { dir: abs, instruments, files };
}

/**
 * 只在给定的根目录里找文件：拼出来的路径必须还在根里面。
 *
 * 大小写不能靠 existsSync 硬试：Windows 上文件名不分大小写，Linux 上分 ——
 * 而目录枚举给出的才是真实文件名。所以先按枚举比对一遍（忽略大小写），
 * 找到真实名字再拼路径，跨平台才不会一个能读一个报「目录里没有」。
 */
export function containedPath(root: string, symbol: string, tf: string): string {
  if (!root) throw new DataError(400, 'NO_DIR', '还没选数据目录');
  if (/[\\/]/.test(symbol)) throw new DataError(400, 'BAD_SYMBOL', '品种名里不能带路径分隔符');
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) throw new DataError(404, 'NO_DIR', '数据目录不在了：' + absRoot);
  const want = (symbol + '_' + tf).toLowerCase();
  const hit = readdirSync(absRoot).find((name) => {
    const ext = extname(name).toLowerCase();
    return (ext === '.parquet' || ext === '.csv') && basename(name, extname(name)).toLowerCase() === want;
  });
  if (!hit) throw new DataError(404, 'NO_FILE', '目录里没有 ' + symbol + '_' + tf + '.parquet（或 .csv）');
  const p = resolve(absRoot, hit);
  if (!p.startsWith(absRoot + sep)) throw new DataError(400, 'BAD_PATH', '路径越界了');
  return p;
}

/** 按时间范围切一段。返回的是闭区间，调用方自己决定要不要丢掉最后一根 */
export function sliceSince(bars: DataBar[], since: number): DataBar[] {
  if (!(since > 0)) return bars;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time < since) lo = mid + 1;
    else hi = mid;
  }
  return bars.slice(lo);
}

/** 目录摘要，给界面显示用：品种数、文件数 */
export function describeDir(dir: string) {
  const scan = scanDir(dir);
  return { ...scan, exists: true };
}
