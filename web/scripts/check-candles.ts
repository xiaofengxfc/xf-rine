/**
 * 命令行体检：一批合约的 K 线到底「难不难看」。
 *
 * 用法：
 *   pnpm check:candles                       # 默认问交易所，看几个有代表性的合约
 *   pnpm check:candles OKB_USDT JNJ_USDT     # 点名看
 *   pnpm check:candles --iv=1m --limit=1000  # 换周期 / 换根数
 *   pnpm check:candles --api=http://127.0.0.1:8787   # 改问本地服务端（看 App 实际拿到的那份）
 *
 * 关心的三件事：
 *   1. 平价 K 线（high === low）占比 —— 高了图上就是一片灰线，看着像残缺；
 *   2. 时间轴有没有洞 —— 真正的残缺，前端会把洞压掉看不出来；
 *   3. 最新一根落后多少 —— 落后太多说明推送没接上。
 */
import { INTERVAL_SEC, isFlatBar, isNoTradeBar, paintBars, sparseStats, type Bar } from '../src/lib/candles.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : '';
};
const apiArg = flag('api');
const apiBase = apiArg ? (apiArg || 'http://127.0.0.1:8787') : '';
const interval = flag('iv') || '15m';
const limit = Number(flag('limit') || 500);
const step = INTERVAL_SEC[interval] ?? 60;
const names = argv.filter((a) => !a.startsWith('--'));
const contracts = names.length > 0
  ? names
  : ['BTC_USDT', 'OKB_USDT', 'JNJ_USDT', 'LULU_USDT', 'MO_USDT', '牛逼_USDT'];

interface Page { bars: Bar[]; gap?: boolean; exhausted?: boolean; error?: string }

async function load(contract: string): Promise<Page> {
  const q = `contract=${encodeURIComponent(contract)}&interval=${interval}&limit=${limit}`;
  const url = apiBase
    ? `${apiBase}/api/candles?${q}`
    : `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?${q}`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    if (!res.ok) return { bars: [], error: `HTTP ${res.status} ${text.slice(0, 80)}` };
    const body = JSON.parse(text) as
      | { bars: Bar[]; gap?: boolean; exhausted?: boolean }
      | { t: number; o: string; h: string; l: string; c: string; v: number }[];
    if (Array.isArray(body)) {
      return {
        bars: body.map((c) => ({ time: Number(c.t), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v) })),
      };
    }
    return { bars: body.bars ?? [], gap: body.gap === true, exhausted: body.exhausted === true };
  } catch (err) {
    return { bars: [], error: (err as Error).message };
  }
}

interface Row {
  contract: string; n: number; flatPct: number; noTradePct: number; visiblePct: number;
  gaps: number; maxGap: number; lagBars: number; gapFlag: string;
}

function audit(contract: string, bars: Bar[], page: Page): Row {
  const s = sparseStats(bars);
  const painted = paintBars(bars, 0);
  let gaps = 0;
  let maxGap = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const d = bars[i]!.time - bars[i - 1]!.time;
    if (d !== step) { gaps += 1; maxGap = Math.max(maxGap, Math.round(d / step)); }
  }
  const newest = bars.length > 0 ? bars[bars.length - 1]!.time : 0;
  const lagBars = newest > 0 ? Math.max(0, Math.round((Date.now() / 1000 - newest) / step)) : -1;
  return {
    contract,
    n: bars.length,
    flatPct: Math.round(s.flatShare * 100),
    noTradePct: Math.round((s.noTrade / Math.max(1, s.count)) * 100),
    visiblePct: Math.round((painted.filter((b) => b.high > b.low).length / Math.max(1, painted.length)) * 100),
    gaps,
    maxGap,
    lagBars,
    gapFlag: page.gap === undefined ? '-' : page.gap ? '有洞' : '连续',
  };
}

const rows: Row[] = [];
for (const c of contracts) {
  const page = await load(c);
  if (page.error) { console.log(`${c.padEnd(16)} 拉取失败: ${page.error}`); continue; }
  const row = audit(c, page.bars, page);
  rows.push(row);
  console.log(
    `${row.contract.padEnd(16)} 根数 ${String(row.n).padStart(4)}  ` +
    `平价 ${String(row.flatPct).padStart(3)}%  无成交 ${String(row.noTradePct).padStart(3)}%  ` +
    `画得出 ${String(row.visiblePct).padStart(3)}%  ` +
    `缺口 ${String(row.gaps).padStart(2)}${row.maxGap > 1 ? `(最大${row.maxGap}根)` : ''}  ` +
    `滞后 ${String(row.lagBars).padStart(3)} 根  ` +
    (apiBase ? `服务端:${row.gapFlag}  ` : ''),
  );
}

console.log('');
const holes = rows.filter((r) => r.gaps > 0);
const stale = rows.filter((r) => r.lagBars > 3);
const sparse = rows.filter((r) => r.flatPct >= 60);
const broken = rows.filter((r) => r.visiblePct < 100);
console.log(`共 ${rows.length} 个合约 · ${interval} · 最近 ${limit} 根`);
console.log(`  时间轴有洞：${holes.length}${holes.length > 0 ? '  ← 这才是真的「残」' : ''}`);
console.log(`  最新一根落后 >3 根：${stale.length}${stale.length > 0 ? '  ← 推送没接上 / 很久没成交' : ''}`);
console.log(`  平价占比 ≥60%：${sparse.length}（图上会出现那条灰色的「成交稀疏」提示）`);
console.log(`  撑开后仍画不出：${broken.length}（应当恒为 0）`);
if (holes.length > 0 || stale.length > 0 || broken.length > 0) process.exit(1);
