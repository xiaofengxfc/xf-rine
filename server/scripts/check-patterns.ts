/**
 * 命令行体检：拉真实 K 线，跑一遍形态识别，把判定依据和原始 OHLC 一起打出来，
 * 便于逐条核对是不是真的那么回事。
 * 用法： pnpm -F server exec tsx scripts/check-patterns.ts BTC_USDT 15m
 */
import { detectPatterns, rollingAtr } from '../src/patterns.js';
import type { Bar } from '../src/levels.js';

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

const atrs = rollingAtr(closed, 14);
const a = atrs[atrs.length - 1] ?? 0;
const pats = detectPatterns(closed, { window: 30, limit: 6 });

const fmt = (t: number) => new Date(t * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const r4 = (v: number) => v.toFixed(4);

console.log(`\n${contract} ${interval}　已收盘 ${closed.length} 根，ATR14 = ${a.toFixed(4)}，识别出 ${pats.length} 个形态\n`);

for (const p of pats) {
  const b = closed[p.index]!;
  const prev = closed[p.index - 1]!;
  const range = b.high - b.low;
  const body = Math.abs(b.close - b.open);
  const upper = b.high - Math.max(b.close, b.open);
  const lower = Math.min(b.close, b.open) - b.low;
  const dir = p.direction === 'bullish' ? '看多' : p.direction === 'bearish' ? '看空' : '中性';

  console.log(`[${p.name}] ${fmt(b.time)}　${dir}　强度 ${p.strength}`);
  console.log(`  本根 O${r4(b.open)} H${r4(b.high)} L${r4(b.low)} C${r4(b.close)}　实体 ${r4(body)} / 区间 ${r4(range)}`);
  console.log(`  上影 ${r4(upper)}（${((upper / range) * 100).toFixed(0)}%）　下影 ${r4(lower)}（${((lower / range) * 100).toFixed(0)}%）　实体占比 ${((body / range) * 100).toFixed(0)}%`);
  console.log(`  前一根 O${r4(prev.open)} C${r4(prev.close)}　区间 ${r4(prev.high - prev.low)}`);
  console.log(`  说明：${p.note}`);
  // 用这根 K 线自己的 ATR 判断，和识别时用的是同一个口径
  const ownAtr = atrs[p.index] ?? 0;
  if (ownAtr > 0 && range < ownAtr * 0.5) console.log('  !! 振幅不足半个 ATR，不该被识别');
  console.log('');
}

// 自检：不能有未来数据 —— 把最后 20 根砍掉重算，前面每一根的结论必须一字不差。
// 两边都要用同一个 window 上限，否则比的是「看了多少根」而不是「有没有偷看未来」。
const cut = closed.length - 20;
// maxPerKind 是展示配额，相对数组末尾计数，要排除掉才能单独验证判定本身
const detectOpts = { window: 9999, limit: 999, maxPerKind: 999 };
const part = detectPatterns(closed.slice(0, cut + 1), detectOpts).map((p) => [p.kind, p.index, p.strength]);
const full = detectPatterns(closed, detectOpts)
  .filter((p) => p.index <= cut)
  .map((p) => [p.kind, p.index, p.strength]);
const same = JSON.stringify(part) === JSON.stringify(full);
console.log('自检 · 不用未来数据：' + (same ? '通过（截断重算结果一致）' : '失败（同一个位置结论变了）'));
console.log('自检 · 每条都有说明文字：' + (pats.every((p) => p.note.length > 6) ? '通过' : '失败'));
console.log('自检 · 同一根 K 线只有一条：' + (new Set(pats.map((p) => p.index)).size === pats.length ? '通过' : '失败'));
const perKind = new Map<string, number>();
for (const p of pats) perKind.set(p.kind, (perKind.get(p.kind) ?? 0) + 1);
console.log('自检 · 同种形态不超过两条：' + ([...perKind.values()].every((n) => n <= 2) ? '通过' : '失败'));
