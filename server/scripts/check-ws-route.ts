import {
  isStale,
  orderRoutes,
  routeOnTrouble,
  SWITCH_AFTER_FAILS,
  type NetRoute,
} from '../src/wsRoute.js';

const checks: [string, boolean][] = [];
const eq = (name: string, passed: boolean) => checks.push([name, passed]);

// ---- 候选路排序 ----
eq('没配代理：只有直连一条',
  JSON.stringify(orderRoutes({ direct: 100, proxy: 50 }, false)) === JSON.stringify(['direct']));

eq('代理更快：代理排前',
  JSON.stringify(orderRoutes({ direct: 900, proxy: 200 }, true)) === JSON.stringify(['proxy', 'direct']));

eq('直连更快：直连排前',
  JSON.stringify(orderRoutes({ direct: 120, proxy: 800 }, true)) === JSON.stringify(['direct', 'proxy']));

eq('只量到直连：直连先试，代理兜底',
  JSON.stringify(orderRoutes({ direct: 120, proxy: 0 }, true)) === JSON.stringify(['direct', 'proxy']));

eq('一条都没量到：先试代理（配代理通常就是因为直连不通）',
  JSON.stringify(orderRoutes({ direct: 0, proxy: 0 }, true)) === JSON.stringify(['proxy', 'direct']));

eq('人工指定 direct：排到最前，代理仍是后备',
  JSON.stringify(orderRoutes({ direct: 900, proxy: 200 }, true, 'direct')) === JSON.stringify(['direct', 'proxy']));

eq('人工指定 proxy：排到最前，直连仍是后备',
  JSON.stringify(orderRoutes({ direct: 100, proxy: 900 }, true, 'proxy')) === JSON.stringify(['proxy', 'direct']));

eq('人工指定但没配代理：忽略，只走直连',
  JSON.stringify(orderRoutes({ direct: 100, proxy: 50 }, false, 'proxy')) === JSON.stringify(['direct']));

eq('人工指定写错：不认，按自动排序',
  JSON.stringify(orderRoutes({ direct: 900, proxy: 200 }, true, 'PROXY!')) === JSON.stringify(['proxy', 'direct']));

// ---- 换路判断 ----
const order: NetRoute[] = ['proxy', 'direct'];

eq('第一次小失败：不换，只记一笔',
  (() => {
    const r = routeOnTrouble(order, 'proxy', 0, 1);
    return r.route === 'proxy' && r.fails === 1 && !r.switched;
  })());

eq('连着两次小失败：换另一条',
  (() => {
    const r = routeOnTrouble(order, 'proxy', 1, 1);
    return r.route === 'direct' && r.fails === 0 && r.switched;
  })());

eq('握手超时（weight=2）：当场换',
  (() => {
    const r = routeOnTrouble(order, 'proxy', 0, 2);
    return r.route === 'direct' && r.switched;
  })());

eq('换过去再栽：换回原来那条，不卡死在一条路上',
  (() => {
    const r = routeOnTrouble(order, 'direct', 0, 2);
    return r.route === 'proxy' && r.switched;
  })());

eq('只有一条路：不换，也不再累计失败',
  (() => {
    const r = routeOnTrouble(['direct'], 'direct', 5, 2);
    return r.route === 'direct' && !r.switched && r.fails === 0;
  })());

eq('阈值是 2 次（改这个常量要一起改测试）', SWITCH_AFTER_FAILS === 2);

// ---- 假死判断 ----
const base = { now: 1_000_000, staleMs: 90_000, subscriptions: 1 };
eq('刚收到数据：不算假死',
  !isStale({ ...base, lastMessageAt: base.now - 10_000 }));
eq('刚过阈值：算假死',
  isStale({ ...base, lastMessageAt: base.now - 90_000 }));
eq('还差一点：不算',
  !isStale({ ...base, lastMessageAt: base.now - 89_999 }));
eq('没有订阅：不判假死（服务端本来就不推）',
  !isStale({ ...base, lastMessageAt: base.now - 999_999, subscriptions: 0 }));
eq('从没收到过：不判假死（刚连上还没订阅）',
  !isStale({ ...base, lastMessageAt: 0 }));

let failures = 0;
for (const [name, passed] of checks) {
  if (passed) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}

if (failures) {
  console.error('✗ 行情选路检查失败 ' + failures + '/' + checks.length);
  process.exit(1);
}
console.log('✓ 行情选路与假死判断全部通过（' + checks.length + ' 项）');
