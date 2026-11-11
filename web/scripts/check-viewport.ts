/**
 * 离线体检：视口换算（web/src/lib/viewport.ts）。
 *
 * 这块逻辑管的是「补历史、换主题之后，画面还停在原来那一段」。
 * 写错了的表现很具体：每补一页历史，K 线就往左挪几根，或者整个窗口被扔到图上别处 ——
 * 所以这里把几种真实形状钉住，跑一遍就知道有没有改坏。
 *
 * 用法：pnpm check:viewport
 */
import { viewportRange } from '../src/lib/viewport.ts';
import type { Bar } from '../src/lib/api.ts';

const BASE = 1_700_000_000;
const STEP = 60;

/** 一根 60 秒的假 K 线。第一根的时间 = start，第 i 根 = start + i * 60 */
const bars = (n: number, start = BASE): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    time: start + i * STEP, open: 1, high: 1.1, low: 0.9, close: 1, volume: 1,
  }));

/** 「原本第 i 根」的时间。补页之后这一根的下标会变大，时间不变 */
const t = (i: number): number => BASE + i * STEP;

let failed = 0;
let total = 0;
function check(name: string, got: unknown, want: unknown): void {
  total += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`
    + (ok ? '' : `\n     得到 ${JSON.stringify(got)}\n     期望 ${JSON.stringify(want)}`));
}

// ---- 1. 停在最新一屏：右侧空位要原样留着 ----
// 原本 1000 根、看最后 160 根（下标 846~999）、右边空 6 格。
// 补进来 1000 根更早的之后，同样这 160 根挪到下标 1846~1999，右边还得空 6 格。
// 少算这几格，画面每补一页就往左挪六根 —— 正是「K 线自己跳一下」的样子。
check(
  '补页后窗口留在同一段时间，右侧仍空 6 格',
  viewportRange(bars(2000, BASE - 1000 * STEP), { fromTime: t(846), toTime: t(999), margin: 6 }),
  { from: 1846, to: 2005 },
);

// ---- 2. 正在看历史：右边界不在最后一根上，空位不参与 ----
check(
  '看历史时窗口原样搬过去，不加空位',
  viewportRange(bars(2000), { fromTime: t(500), toTime: t(700), margin: 6 }),
  { from: 500, to: 700 },
);

// ---- 3. 根数变少（切走再切回来只拿到一页）：仍然按时间找回 ----
check(
  '数据变短后仍按时间找回',
  viewportRange(bars(1000), { fromTime: t(500), toTime: t(700), margin: 0 }),
  { from: 500, to: 700 },
);

// ---- 4. 那一段时间已经不在数据里了：不动，返回 null ----
check('时间落在数据之后：返回 null', viewportRange(bars(100), { fromTime: t(500), toTime: t(700), margin: 6 }), null);
check('空数据：返回 null', viewportRange([], { fromTime: t(0), toTime: t(10), margin: 6 }), null);
check('窗口只有一根：返回 null', viewportRange(bars(100), { fromTime: t(10), toTime: t(10), margin: 0 }), null);

// ---- 5. 恢复上次视口：太窄的窗口不认 ----
const saved = { fromTime: t(994), toTime: t(999), margin: 6 };
check('默认至少两根', viewportRange(bars(1000), saved), { from: 994, to: 1005 });
check('要求至少 8 根时不认这段', viewportRange(bars(1000), saved, 8), null);

// ---- 6. 右边界越界（可见区被夹在最后一根上）：贴住最后一根再加空位 ----
check('右边界越界时贴住最后一根', viewportRange(bars(1000), { fromTime: t(900), toTime: t(5000), margin: 6 }), { from: 900, to: 1005 });

// ---- 7. 空位是小数（拖动中常常跨半根）时取整 ----
check('空位取整', viewportRange(bars(1000), { fromTime: t(900), toTime: t(999), margin: 2.4 }), { from: 900, to: 1001 });
check('负的空位当 0', viewportRange(bars(1000), { fromTime: t(900), toTime: t(999), margin: -3 }), { from: 900, to: 999 });

if (failed > 0) {
  console.error(`\n✗ ${failed} 项失败，${total - failed} 项通过`);
  process.exit(1);
}
console.log(`\n✓ 视口换算全部通过（${total} 项）`);
