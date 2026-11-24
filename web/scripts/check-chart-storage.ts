/**
 * 图表存储键迁移的自检。
 *
 * 这块最贵的错法是「改完键，用户存的画线全部读不到」—— 不报错，只是图上是空的。
 * 所以下面一半用例在钉迁移：老键有数据时必须能读到，并且迁进新键。
 */
import {
  chartStorageKeys, clearChartValue, readChartValue, writeChartValue, type StorageLike,
} from '../src/lib/chartStorage.ts';

let failures = 0;
function check(name: string, ok: boolean): void {
  if (ok) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}

function fakeStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

const base = { scope: '', contract: 'BTC_USDT', interval: '15m' };

// ---- 键的形状 ----
const legacy = chartStorageKeys('drawings', base);
check('没有身份时就用老键', legacy.key === 'xf-rine:drawings:BTC_USDT:15m' && legacy.legacy === legacy.key);

const fresh = chartStorageKeys('drawings', { ...base, instrument: 'gate:perp:BTC_USDT' });
check('有身份时键里带身份', fresh.key === 'xf-rine:drawings:gate:perp:BTC_USDT:15m');
check('老键仍然指得出', fresh.legacy === 'xf-rine:drawings:BTC_USDT:15m');
check('两种键不会撞', fresh.key !== fresh.legacy);

const research = chartStorageKeys('drawings', { ...base, scope: 'research:', instrument: 'gate:perp:BTC_USDT' });
check('研究台有自己的命名空间', research.key === 'xf-rine:drawings:research:gate:perp:BTC_USDT:15m');
check('研究台的老键也对', research.legacy === 'xf-rine:drawings:research:BTC_USDT:15m');

check('视口和画线用不同的前缀',
  chartStorageKeys('view', base).key === 'xf-rine:view:BTC_USDT:15m');

// ---- 迁移 ----
const s1 = fakeStorage({ 'xf-rine:drawings:BTC_USDT:15m': 'OLD' });
check('新键没有时读到老键的值', readChartValue(fresh, s1) === 'OLD');
check('读到老键之后顺手迁进新键', s1.map.get(fresh.key) === 'OLD');
check('老键保留着（迁移是单向的，删了就回不去）', s1.map.get(fresh.legacy) === 'OLD');

const s2 = fakeStorage({ 'xf-rine:drawings:BTC_USDT:15m': 'OLD', 'xf-rine:drawings:gate:perp:BTC_USDT:15m': 'NEW' });
check('两个键都有时以新键为准', readChartValue(fresh, s2) === 'NEW');

const s3 = fakeStorage();
check('两个键都没有时返回 null', readChartValue(fresh, s3) === null);

// ---- 写 ----
const s4 = fakeStorage();
writeChartValue(fresh, 'DRAWN', s4);
check('写进的是新键', s4.map.get(fresh.key) === 'DRAWN');
check('写不会碰老键', !s4.map.has(fresh.legacy));

// ---- 清空 ----
const s5 = fakeStorage({ 'xf-rine:drawings:BTC_USDT:15m': 'OLD', 'xf-rine:drawings:gate:perp:BTC_USDT:15m': 'NEW' });
clearChartValue(fresh, s5);
check('清空把新键删掉', !s5.map.has(fresh.key));
check('清空也删老键，否则旧画线又会被迁回来', !s5.map.has(fresh.legacy));

const s6 = fakeStorage({ 'xf-rine:drawings:BTC_USDT:15m': 'OLD' });
clearChartValue(legacy, s6);
check('没有身份时清空只删一个键', s6.map.size === 0);

// ---- 存储不可用 ----
const broken: StorageLike = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceeded'); },
  removeItem: () => { throw new Error('SecurityError'); },
};
check('存储抛异常时读返回 null 而不是崩', readChartValue(fresh, broken) === null);
check('存储抛异常时写不抛', (() => { writeChartValue(fresh, 'x', broken); return true; })());
check('存储抛异常时清空不抛', (() => { clearChartValue(fresh, broken); return true; })());

if (failures) process.exit(1);
console.log('✓ 图表存储键迁移检查通过');
