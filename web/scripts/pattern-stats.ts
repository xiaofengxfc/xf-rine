/**
 * 形态统计：决定「哪些形态该上图」的依据，用滚动多折的做法保证它不自己骗自己。
 *
 * 为什么要有这个脚本：库自己的 patternMetadata 里写明了，confidence 是「与上下文
 * 无关的固定值、已废弃」。而界面上「strong 直接显示、moderate 过高门槛」正是压在
 * 那张表上 —— 实测下来它等于「吞没探测器」（见 README 的 K 线形态一节）。
 *
 * 为什么要闭环：第一版是「拿同一段数据既选形态又验形态」。70456 根、25 个形态、
 * 5 个周期，一共产出 125 个假设，跑出 1 个 z=1.82 —— 那正好是假阳性的期望个数。
 * 所以改成滚动多折：
 *
 *   折 1: [----- 训练 -----][- 测试 -]
 *   折 2: [-------- 训练 -------][- 测试 -]
 *   折 3: [----------- 训练 ----------][- 测试 -]
 *
 * 每一折只在训练段上选（跑 BH 校正），然后在**之后的**测试段上验。训练段的最后
 * HORIZON 根不参与（收益要用到测试段的价格，那就算偷看未来了）。
 * 最后把各折的测试段拼起来，得到的是一份「从没见过的那部分数据上的表现」。
 * 这份表才是界面用的。训练段的表现只写进报告，不入表。
 *
 * 用法：
 *   pnpm stats:patterns                        # 4 个合约 × 5 个周期，从 Gate 拉
 *   pnpm stats:patterns --intervals 5m,1h
 *   pnpm stats:patterns --refresh              # 忽略本地缓存，重新拉
 *   pnpm stats:patterns --dir <目录>           # 离线：读已有 JSON
 *   pnpm stats:patterns --folds 4              # 折数（默认 3）
 *   pnpm stats:patterns --no-walk              # 不分折，退回全样本（只能用于对照，不能入表）
 *
 * 产物：web/src/lib/patternStats.ts（整个覆盖，文件头写着样本和折法，别手改）。
 *
 * 口径：
 *   · 信号在第 i 根收盘确认，收益从第 i 根收盘算起，持有 h 根，h ∈ {1,3,5}，主口径 3；
 *   · 收益按方向对齐（看涨取 +r，看跌取 -r），再除以当根的 ATR/收盘价，换成「几倍 ATR」；
 *   · 基准按方向分开算：看涨形态比「随便挑一根做多」，看跌形态比做空；
 *   · 默认把 5 个周期并成一份（--key all）：分周期的话最短的那个只有两千根，
 *     十来个形态摊下来每个只有几十次命中，z 值基本没有分辨力；
 *   · **多重检验校正**：Benjamini-Hochberg，在每一折的训练段内部做，假发现率 10%。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATTERNS } from '../src/lib/patternCatalogue.ts';
import {
  HORIZONS, PRIMARY, MIN_SAMPLES, MIN_EXCESS, FDR,
  ATR_PERIOD, TREND_PERIOD,
  newBucket, newAcc, feed, rowsOf, tierOf, quantile, normalize, fetchGate, loadDir,
  walkForward, type Bucket, type Series,
} from './pattern-core.ts';

// ---------- 参数 ----------
interface Options {
  symbols: string[];
  intervals: string[];
  bars: number;
  refresh: boolean;
  dir: string | null;
  out: string;
  cache: string;
  key: 'all' | 'interval';
  folds: number;
  walk: boolean;
}
const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function parseArgs(argv: string[]): Options {
  const opt: Options = {
    symbols: ['BTC_USDT', 'ETH_USDT', 'DOGE_USDT', 'SOL_USDT'],
    intervals: ['5m', '15m', '1h', '4h', '1d'],
    bars: 4000,
    refresh: false,
    dir: null,
    out: join(ROOT, 'web/src/lib/patternStats.ts'),
    cache: join(ROOT, '.scratch/pattern-stats-cache'),
    key: 'all',
    folds: 3,
    walk: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (a === '--symbols') opt.symbols = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--intervals') opt.intervals = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--bars') opt.bars = Math.max(200, Number(next()) || 4000);
    else if (a === '--refresh') opt.refresh = true;
    else if (a === '--dir') opt.dir = next();
    else if (a === '--out') opt.out = next();
    else if (a === '--cache') opt.cache = next();
    else if (a === '--folds') opt.folds = Math.max(2, Math.min(6, Number(next()) || 3));
    else if (a === '--no-walk') opt.walk = false;
    else if (a === '--key') {
      const v = next();
      if (v !== 'all' && v !== 'interval') throw new Error('--key 只能是 all 或 interval');
      opt.key = v;
    } else throw new Error('不认识的参数：' + a);
  }
  return opt;
}

// ---------- 取数 ----------

async function collect(opt: Options): Promise<Series[]> {
  if (!opt.dir) mkdirSync(opt.cache, { recursive: true });
  const out: Series[] = [];
  for (const interval of opt.intervals) {
    for (const contract of opt.symbols) {
      const cacheFile = join(opt.cache, contract + '_' + interval + '.json');
      let bars: Bar[] = [];
      if (opt.dir) {
        bars = loadDir(opt.dir, contract, interval, opt.bars);
      } else if (!opt.refresh && existsSync(cacheFile)) {
        bars = normalize(JSON.parse(readFileSync(cacheFile, 'utf8'))).slice(-opt.bars);
      } else {
        process.stdout.write('拉取 ' + contract + ' ' + interval + ' … ');
        bars = await fetchGate(contract, interval, opt.bars);
        writeFileSync(cacheFile, JSON.stringify(bars));
        console.log(bars.length + ' 根');
      }
      if (bars.length < ATR_PERIOD + TREND_PERIOD + HORIZONS[HORIZONS.length - 1]! + 10) continue;
      out.push({ contract, interval, bars });
    }
  }
  return out;
}

// ---------- 主流程 ----------
async function main(): Promise<void> {
  const opt = parseArgs(process.argv.slice(2));
  const series = await collect(opt);
  if (series.length === 0) throw new Error('一根 K 线都没拿到，检查 --symbols / --intervals / --dir');

  const totalBars = series.reduce((n, s) => n + s.bars.length, 0);
  const firstTime = Math.min(...series.map((s) => s.bars[0]!.time));
  const lastTime = Math.max(...series.map((s) => s.bars[s.bars.length - 1]!.time));
  const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

  const walked = opt.walk && opt.folds >= 2 ? walkForward(series, opt.folds) : null;
  const bucket = walked ? walked.test : (() => {
    const b = newBucket();
    for (const s of series) feed(b, s.bars);
    return b;
  })();

  const rows = rowsOf(bucket);
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * 形态实测统计。**这个文件是脚本生成的，别手改。**');
  lines.push(' *');
  lines.push(' * 生成命令：pnpm stats:patterns（脚本在 web/scripts/pattern-stats.ts）');
  lines.push(' * 数据源：Gate 永续公开 K 线（' + (opt.dir ? '离线目录 ' + opt.dir : 'api.gateio.ws') + '）');
  lines.push(' * 样本：' + opt.symbols.join(' / ') + '，周期 ' + opt.intervals.join(' / ') + '，按 ' + (opt.key === 'all' ? '全部周期合并' : '周期分开') + '统计');
  lines.push(' * 区间：' + iso(firstTime) + ' ~ ' + iso(lastTime) + ' UTC，共 ' + totalBars + ' 根');
  lines.push(' *');
  if (walked) {
    lines.push(' * **这份表是折外结果。** ' + opt.folds + ' 折滚动：每折只在训练段上选形态，在之后的测试段上验，');
    lines.push(' * 下面列的是各折测试段合并后的表现 —— 选的时候没见过的数据。');
  } else {
    lines.push(' * 警告：这次没分折（--no-walk），下面是全样本结果，**既选又验**，只能用于对照。');
  }
  lines.push(' *');
  lines.push(' * 口径：第 i 根收盘确认，持有 ' + HORIZONS.join('/') + ' 根（主口径 ' + PRIMARY + '）；收益按方向对齐后');
  lines.push(' * 除以当根 ATR/收盘价。base 是同一样本里「随便挑一根、按同一方向做」的正确率，');
  lines.push(' * excess = win − base 才是这个形态的增量。q 是 Benjamini-Hochberg 校正后的假发现率。');
  lines.push(' * tier 0 = 样本不足或校正后没有增量，1~3 = 增量越显著越高。');
  lines.push(' *');
  lines.push(' * 注意：tier **不是**上不上图的门槛。实测一个形态都过不了线，按门槛筛会让整个开关变成');
  lines.push(' * 死功能。界面只按 tier 决定稀疏程度和排序，标记本身只标位置、不标方向（见 patterns.ts）。');
  lines.push(' */');
  lines.push('');
  lines.push('export type StatTier = 0 | 1 | 2 | 3;');
  lines.push('');
  lines.push('export interface PatternStat {');
  lines.push('  /** 样本数（形态命中次数） */');
  lines.push('  n: number;');
  lines.push('  /** 方向正确率（主口径持有 ' + PRIMARY + ' 根） */');
  lines.push('  win: number;');
  lines.push('  /** 同一样本、同方向的基准正确率 */');
  lines.push('  base: number;');
  lines.push('  /** win − base */');
  lines.push('  excess: number;');
  lines.push('  /** 单尾 z */');
  lines.push('  z: number;');
  lines.push('  /** BH 校正后的假发现率 */');
  lines.push('  q: number;');
  lines.push('  /** 以 ATR 为单位的平均方向收益（主口径，单笔夹在 ±10 以内） */');
  lines.push('  edgeAtr: number;');
  lines.push('  /** 各持有期的正确率，按 HORIZONS 顺序 */');
  lines.push('  winByHorizon: number[];');
  lines.push('  tier: StatTier;');
  lines.push('}');
  lines.push('');
  lines.push('/** 口径 key（默认 all = 所有周期合并）→ 形态 id → 统计 */');
  lines.push('export const PATTERN_STATS: Record<string, Record<string, PatternStat>> = {');
  lines.push('  "all": {');
  for (const row of [...rows].sort((a, b) => b.acc.n - a.acc.n)) {
    const tier = tierOf(row);
    const rec = {
      n: row.acc.n,
      win: Number(row.win.toFixed(4)),
      base: Number(row.base.toFixed(4)),
      excess: Number(row.excess.toFixed(4)),
      z: Number(row.z.toFixed(2)),
      q: Number(row.q.toFixed(4)),
      edgeAtr: Number(row.edgeAtr.toFixed(3)),
      winByHorizon: row.winByHorizon.map((v) => Number(v.toFixed(4))),
      tier,
    };
    lines.push('    ' + JSON.stringify(row.id) + ': ' + JSON.stringify(rec) + ',');
  }
  lines.push('  },');
  lines.push('};');
  lines.push('');

  // 趋势灵敏度：让「本周期 p75 的对齐度」正好落在 0.9
  const byInterval = new Map<string, Bucket>();
  for (const s of series) {
    let b = byInterval.get(s.interval);
    if (!b) { b = newBucket(); byInterval.set(s.interval, b); }
    feed(b, s.bars);
  }
  lines.push('export const TREND_SENSITIVITY: Record<string, number> = {');
  for (const [interval, b] of byInterval) {
    b.aligns.sort((a, bb) => a - bb);
    const p75 = Math.max(1e-9, quantile(b.aligns, 0.75));
    const s = Math.min(20000, Math.max(0.5, 0.4 / p75));
    lines.push('  ' + JSON.stringify(interval) + ': ' + Number(s.toFixed(2)) + ',');
  }
  lines.push('};');
  lines.push('');
  lines.push('/** 生成时用的样本和折法，界面和自检都从这里读口径 */');
  lines.push('export const PATTERN_STATS_SAMPLE = ' + JSON.stringify({
    key: opt.key,
    symbols: opt.symbols,
    intervals: opt.intervals,
    bars: totalBars,
    from: iso(firstTime),
    to: iso(lastTime),
    horizons: [...HORIZONS],
    primaryHorizon: PRIMARY,
    minSamples: MIN_SAMPLES,
    fdr: FDR,
    minExcess: MIN_EXCESS,
    /** null = 没分折（全样本，既选又验） */
    folds: walked ? opt.folds : null,
    source: opt.dir ? 'dir:' + opt.dir : 'gate-futures',
  }, null, 2) + ';');
  lines.push('');

  writeFileSync(opt.out, lines.join('\n'));

  console.log('\nkey\tid\t中文名\tn\twin%\tbase%\texcess\tz\tq\tedgeAtr\ttier');
  for (const row of [...rows].sort((a, b) => b.acc.n - a.acc.n)) {
    console.log(['all', row.id, PATTERNS[row.id]?.name ?? '', String(row.acc.n), (row.win * 100).toFixed(1),
      (row.base * 100).toFixed(1), (row.excess * 100).toFixed(1), row.z.toFixed(2), row.q.toFixed(3),
      row.edgeAtr.toFixed(2), String(tierOf(row))].join('\t'));
  }
  if (walked) {
    console.log('\n折\t训练段根数\t测试段根数\t选中形态数\t训练段增量\t测试段增量\t差值\t选中');
    for (const r of walked.reports) {
      const gap = (r.trainExcess - r.testExcess) * 100;
      console.log([String(r.fold), String(r.trainBars), String(r.testBars), String(r.picked),
        (r.trainExcess * 100).toFixed(2) + 'pp', (r.testExcess * 100).toFixed(2) + 'pp',
        gap.toFixed(2) + 'pp', r.detail].join('\t'));
    }
    // 训练段选中的形态，在测试段还站得住吗 —— 这是闭环唯一要回答的问题
    const pickedTotal = walked.reports.reduce((n, r) => n + r.picked, 0);
    const gapSum = walked.reports.reduce((n, r) => n + (r.trainExcess - r.testExcess) * 100, 0);
    console.log('折外衰减：' + (pickedTotal ? (gapSum / pickedTotal).toFixed(2) : '0.00') + 'pp（正 = 训练段的增量在测试段掉下来）');
  }
  const passed = rows.filter((r) => tierOf(r) >= 1);
  console.log('\n过门槛的形态：' + (passed.length ? passed.map((r) => r.id + '(' + tierOf(r) + ')').join(', ') : '无（一个都没有）'));
  console.log('写入 ' + opt.out);
  console.log('样本 ' + totalBars + ' 根，' + iso(firstTime) + ' ~ ' + iso(lastTime) + ' UTC');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
