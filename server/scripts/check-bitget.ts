/**
 * Bitget 接入自检。
 *
 *   pnpm -F server exec tsx scripts/check-bitget.ts
 *   pnpm -F server exec tsx scripts/check-bitget.ts --order     （会真下一张远价单再撤掉）
 *
 * 为什么要有这个脚本：密钥配没配对，界面上只有「未配置 / 已配置尾号」，
 * 但配了之后最常见的两个坑——少填 PASSPHRASE、API 没勾合约交易权限——
 * 要等到下单那一刻才炸，而且报错是英文。这里一条条打出来：
 *
 *   1. 三把钥匙都在不在；
 *   2. 合约元数据（乘数、最小张数、价格精度）读不读得到；
 *   3. 账户、持仓、挂单、保护单能不能读；
 *   4. （可选）下一张远离现价的限价单再撤掉 —— 这一步验的是签名和下单权限，
 *      价格挂在现价一半的位置，不会成交。
 *
 * 只读检查不会动账户；带 --order 也只挂不成交的单，挂完立刻撤。
 */

/**
 * 标成模块（而不是脚本），有两个原因：
 *   1. 顶层 await 只有模块才能用，而这里要「先定住交易所、再动态 import config」；
 *   2. scripts/ 里还有别的脚本也没写 import，同一个全局作用域下会互相撞名字
 *      （比如好几个脚本都有个叫 ok 的函数）。
 */
export {};

// 必须在 import config 之前定住交易所，否则读到的还是 .env 里的默认值
process.env.EXCHANGE = 'bitget';

const wantOrder = process.argv.includes('--order');

const { config, envLabel } = await import('../src/config.js');
const { exchange } = await import('../src/exchange/index.js');
const { GateError } = await import('../src/exchange/errors.js');

let bad = 0;
function ok(title: string, detail = ''): void {
  console.log('  ✓ ' + title + (detail ? '   ' + detail : ''));
}
function fail(title: string, detail = ''): void {
  bad += 1;
  console.log('  ✗ ' + title + (detail ? '   ' + detail : ''));
}
function line(): void { console.log(''); }

console.log('');
console.log('  Bitget 接入自检   环境：' + envLabel() + '    配置：' + config.exchange);
line();

const ex = exchange();

// 1. 三把钥匙
if (!config.key) fail('ACCESS KEY 没配');
else ok('ACCESS KEY', config.key.slice(0, 4) + '••••' + config.key.slice(-4));
if (!config.secret) fail('SECRET 没配');
else ok('SECRET', '已配置');
if (!config.passphrase) fail('PASSPHRASE 没配 —— Bitget 少这一样，读账户和下单都会被拒');
else ok('PASSPHRASE', '已配置');

if (bad > 0) {
  line();
  console.log('  密钥不齐，后面的检查会全部失败。到设置页把三样都填上再跑一次。');
  process.exit(1);
}

// 2. 合约元数据
const contract = 'BTC_USDT';
let info = null as Awaited<ReturnType<typeof ex.publicContract>> | null;
try {
  info = await ex.publicContract(contract);
  const mult = Number(info.quanto_multiplier);
  ok('合约 ' + contract,
    '1 张 = ' + mult + ' 个币 · 最小 ' + info.order_size_min + ' 张 · 价格精度 ' + info.order_price_round
    + ' · 杠杆 ' + info.leverage_min + '-' + info.leverage_max + ' · 现价 ' + info.last_price);
  if (!(mult > 0)) fail('合约乘数是 0，张数换算会算错', 'quanto_multiplier=' + info.quanto_multiplier);
  if (!(Number(info.last_price) > 0)) fail('拿不到最新价，市价单的名义价值估不出来');
} catch (e) {
  fail('读不到合约元数据', msg(e));
}

// 3. 私有接口
try {
  const a = await ex.account();
  ok('账户', '总权益 ' + a.total.toFixed(2) + ' · 可用 ' + a.available.toFixed(2) + ' ' + a.currency);
} catch (e) {
  fail('读账户失败', msg(e));
}

try {
  const p = await ex.positions();
  if (p.length === 0) ok('持仓', '当前没有持仓');
  else {
    ok('持仓 ' + p.length + ' 条');
    for (const row of p) {
      console.log('      ' + row.contract + '  ' + (row.mode.includes('short') ? '空' : '多')
        + '  ' + Math.abs(Number(row.size)) + ' 张 @ ' + row.entry_price
        + '  现在 ' + row.mark_price + '  盈亏 ' + row.unrealised_pnl + '  ' + row.leverage + 'x');
    }
  }
} catch (e) {
  fail('读持仓失败', msg(e));
}

try {
  const o = await ex.openOrders();
  ok('挂单', o.length === 0 ? '没有挂着的委托' : o.length + ' 张');
  for (const row of o) {
    console.log('      ' + row.contract + '  ' + (Number(row.size) > 0 ? '买' : '卖')
      + '  ' + Math.abs(Number(row.size)) + ' 张 @ ' + row.price + '  剩 ' + row.left);
  }
} catch (e) {
  fail('读挂单失败', msg(e));
}

try {
  const t = await ex.triggers();
  ok('保护单', t.length === 0 ? '没有到价平仓的保护单' : t.length + ' 张');
  for (const row of t) {
    console.log('      ' + row.initial.contract + '  ' + (row.initial.auto_size === 'close_short' ? '平空' : '平多')
      + '  触发价 ' + row.trigger.price + '  ' + (row.trigger.rule === 1 ? '涨到' : '跌到'));
  }
} catch (e) {
  fail('读保护单失败', msg(e));
}

// 4. 可选：下一张远价单再撤掉
if (wantOrder && info) {
  const price = Number(info.last_price);
  const round = Number(info.order_price_round) || 0.1;
  // 挂在现价的一半：涨到那儿之前不会成交；张数取最小值
  const raw = price * 0.5;
  const far = Math.floor(raw / round) * round;
  try {
    const order = await ex.placeOrder({
      contract,
      size: Math.max(1, info.order_size_min),
      price: far.toFixed(decimals(round)),
      tif: 'gtc',
      reduce_only: false,
    });
    ok('下单', '单号 ' + order.id + ' · ' + Math.abs(Number(order.size)) + ' 张 @ ' + order.price + ' · 状态 ' + order.status);
    await ex.cancelOrder(order.id);
    ok('撤单', '已撤 ' + order.id);
  } catch (e) {
    fail('下单/撤单失败', msg(e));
  }
} else if (!wantOrder) {
  line();
  console.log('  想连下单权限一起验，加 --order：会挂一张现价一半的限价单再立刻撤掉。');
}

line();
console.log(bad === 0 ? '  全部通过。' : '  有 ' + bad + ' 项没过，见上面。');
process.exit(bad === 0 ? 0 : 1);

function decimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(12, s.length - i - 1);
}

function msg(e: unknown): string {
  if (e instanceof GateError) return e.label + ' ' + e.detail;
  return e instanceof Error ? e.message : String(e);
}
