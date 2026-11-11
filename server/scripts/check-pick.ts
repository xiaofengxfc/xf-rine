/**
 * 右键带价的自检。
 *
 * 右键取价本身是「把鼠标位置换成价格」，没什么好测的；真正会出事的是后两个动作：
 * 「覆盖持仓止损 / 止盈」。/api/bracket 是覆盖语义（先撤掉这一边已有的触发单，再挂新价），
 * 所以「只改止损」必须把止盈从现有触发单里读回来一起传 —— 少传那一边，就等于把止盈撤掉了，
 * 用户以为动了一边，其实裸了一边。这条逻辑单独拎到这里验。
 *
 * 跑法：pnpm check:pick
 */

let fails = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { console.log('  ✓ ' + label); return; }
  fails += 1;
  console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
};

interface Trig { direction: 'long' | 'short'; triggerPrice: number }

/**
 * 和 App.tsx 里 applyToPosition 同一套判定：这一边现有的触发单按价格分到止损/止盈两侧。
 * 交易所的触发单里没有「这是止损」这个字段，价格大小就是语义：
 * 多头止损在下、止盈在上；空头反过来。
 */
function bracketFor(direction: 'long' | 'short', mark: number, trigs: Trig[], kind: 'stop' | 'target', price: number) {
  const mine = trigs.filter((t) => t.direction === direction);
  const below = mine.filter((t) => t.triggerPrice < mark).map((t) => t.triggerPrice);
  const above = mine.filter((t) => t.triggerPrice > mark).map((t) => t.triggerPrice);
  const nearest = (xs: number[]) => xs.reduce((a, b) => (Math.abs(b - mark) < Math.abs(a - mark) ? b : a), 0);
  const stopList = direction === 'long' ? below : above;
  const targetList = direction === 'long' ? above : below;
  return {
    stop: kind === 'stop' ? price : nearest(stopList),
    target: kind === 'target' ? price : nearest(targetList),
  };
}

console.log('多头');
{
  const trigs: Trig[] = [
    { direction: 'long', triggerPrice: 100 },  // 止损
    { direction: 'long', triggerPrice: 130 },  // 止盈
    { direction: 'short', triggerPrice: 90 },  // 另一个方向的，不该被读进来
  ];
  const r = bracketFor('long', 110, trigs, 'stop', 104);
  ok(r.stop === 104, '改止损：用右键给的价');
  ok(r.target === 130, '改止损：止盈保持原样（从现有触发单读回来）', String(r.target));
  const r2 = bracketFor('long', 110, trigs, 'target', 125);
  ok(r2.stop === 100 && r2.target === 125, '改止盈：止损保持原样', JSON.stringify(r2));
}

console.log('空头');
{
  const trigs: Trig[] = [
    { direction: 'short', triggerPrice: 120 }, // 止损（在上方）
    { direction: 'short', triggerPrice: 95 },  // 止盈（在下方）
  ];
  const r = bracketFor('short', 105, trigs, 'stop', 116);
  ok(r.stop === 116, '空头改止损：用右键给的价');
  ok(r.target === 95, '空头改止损：止盈保持原样', String(r.target));
  const r2 = bracketFor('short', 105, trigs, 'target', 88);
  ok(r2.stop === 120 && r2.target === 88, '空头改止盈：止损保持原样', JSON.stringify(r2));
}

console.log('只有一边')
{
  const trigs: Trig[] = [{ direction: 'long', triggerPrice: 100 }];
  const r = bracketFor('long', 110, trigs, 'target', 125);
  ok(r.stop === 100 && r.target === 125, '原来只有止损：改止盈时止损不丢', JSON.stringify(r));
  const r2 = bracketFor('long', 110, [], 'target', 125);
  ok(r2.stop === 0 && r2.target === 125, '一张触发单都没有：另一边给 0（服务端按「不挂」处理）', JSON.stringify(r2));
}

console.log('同侧多张')
{
  const trigs: Trig[] = [
    { direction: 'long', triggerPrice: 96 },   // 更远的止损
    { direction: 'long', triggerPrice: 104 },  // 贴着现价的止损
  ];
  const r = bracketFor('long', 110, trigs, 'target', 128);
  ok(r.stop === 104, '同一侧挂了好几张：取离现价最近的那张', String(r.stop));
}

console.log('');
if (fails > 0) {
  console.log('右键带价自检：' + fails + ' 项没过');
  process.exit(1);
}
console.log('✓ 右键带价自检全部通过');
