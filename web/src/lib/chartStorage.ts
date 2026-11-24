/**
 * 图表本地存储的键：画线、视口各存一份，按「哪个页面 + 哪个品种 + 哪个周期」分开。
 *
 * 为什么要单独一个模块：键里带着品种身份，而身份刚从裸符号（`BTC_USDT`）
 * 换成 `venue:market:symbol`。键一改，用户浏览器里存的画线就读不到了 ——
 * 而且不会报错，只是打开图是空的。
 *
 * 所以第一次读新键读不到时，回退到老键；从老键读到了，顺手写进新键。
 * 迁完**不删老键**：迁移是单向的，删掉就回不去；一份画线几 KB，留着当备份。
 * 「清空画线」两个键一起清，否则老键会把画线又带回来。
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ChartStorageKind = 'drawings' | 'view';

export interface ChartStorageInput {
  /** 研究台和日内台各自一个命名空间，同品种同时期共用一个键会互相覆盖 */
  scope: string;
  /** 裸品种名，例如 BTC_USDT（老键里用的就是它） */
  contract: string;
  interval: string;
  /** 完整身份，例如 gate:perp:BTC_USDT。没有就只用老键 */
  instrument?: string;
}

export interface ChartStorageKeys {
  /** 现在用来读写的键 */
  key: string;
  /** 上一个版本用的键（只有裸符号）。等于 key 时说明没有迁移这回事 */
  legacy: string;
}

function build(kind: ChartStorageKind, id: string, interval: string): string {
  return `xf-rine:${kind}:${id}:${interval}`;
}

export function chartStorageKeys(kind: ChartStorageKind, input: ChartStorageInput): ChartStorageKeys {
  const legacy = build(kind, input.scope + input.contract, input.interval);
  const instrument = (input.instrument ?? '').trim();
  // 没有身份（配置还没回来、或者根本不是这个台的图）就退回老键，别拼出一个半截的键
  if (!instrument) return { key: legacy, legacy };
  return { key: build(kind, input.scope + instrument, input.interval), legacy };
}

function storageOf(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // 隐私模式下访问 localStorage 会抛
  }
}

/**
 * 读。新键优先；新键没有、老键有，就把老键的值迁进新键再返回。
 * 读写都不该让页面打不开，所以存储不可用、抛异常一律当成「没有」。
 */
export function readChartValue(keys: ChartStorageKeys, storage?: StorageLike): string | null {
  const s = storageOf(storage);
  if (!s) return null;
  let fresh: string | null = null;
  try { fresh = s.getItem(keys.key); } catch { return null; }
  if (fresh !== null) return fresh;
  if (keys.legacy === keys.key) return null;
  let old: string | null = null;
  try { old = s.getItem(keys.legacy); } catch { return null; }
  if (old === null) return null;
  // 迁移：写不进新键也照样把值给出去，这一次至少能正常显示
  try { s.setItem(keys.key, old); } catch { /* 配额满了就算了 */ }
  return old;
}

export function writeChartValue(keys: ChartStorageKeys, value: string, storage?: StorageLike): void {
  const s = storageOf(storage);
  if (!s) return;
  try { s.setItem(keys.key, value); } catch { /* 配额满了就算了 */ }
}

/** 两个键一起清：老键留着的话，下一次读又会把旧画线迁回来 */
export function clearChartValue(keys: ChartStorageKeys, storage?: StorageLike): void {
  const s = storageOf(storage);
  if (!s) return;
  try { s.removeItem(keys.key); } catch { /* ignore */ }
  if (keys.legacy !== keys.key) {
    try { s.removeItem(keys.legacy); } catch { /* ignore */ }
  }
}
