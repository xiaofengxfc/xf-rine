/**
 * 请求参数解析的自检。
 *
 * 校验层本身没什么算法，但它决定了「字段写错时用户看到什么」。
 * 以前每个接口各写各的 `Number(body.size)`，漏传字段会一路 NaN 飘到下游，
 * 报出来的话和真正的原因对不上 —— 这些用例就是钉住现在这套行为。
 */
import {
  bodyOf, flag, numberOr, oneOf, oneOfOr, optionalNumber, requiredNumber, requiredText,
} from '../src/http/params.js';

let failures = 0;
function check(name: string, ok: boolean): void {
  if (ok) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}

/** 断言这一段会抛 400 BAD_INPUT，并且话说到了字段名上 */
function rejects(run: () => unknown, name: string, expect?: string): void {
  try {
    run();
    check(name + '（应当报错，实际通过了）', false);
  } catch (error) {
    const e = error as { status?: number; label?: string; message?: string };
    const ok = e.status === 400 && e.label === 'BAD_INPUT' && (!expect || (e.message ?? '').includes(expect));
    check(name, ok);
  }
}

// ---- 请求体 ----
check('空的请求体当成空对象', Object.keys(bodyOf(undefined)).length === 0);
check('普通对象原样返回', bodyOf({ a: 1 }).a === 1);
rejects(() => bodyOf('not-an-object'), '字符串请求体被拒', 'JSON 对象');
rejects(() => bodyOf([1, 2]), '数组请求体被拒', 'JSON 对象');

// ---- 数字 ----
check('数字字段接受数字串', requiredNumber('12.5', 'size') === 12.5);
check('数字字段接受 number', requiredNumber(3, 'size') === 3);
rejects(() => requiredNumber(undefined, 'size'), '缺字段报「缺少 size」', '缺少 size');
rejects(() => requiredNumber('abc', 'size'), '非数字被拒', '必须是数字');
rejects(() => requiredNumber(-1, 'size', { positive: true }), '正数约束生效', '大于 0');
rejects(() => requiredNumber(1.5, 'size', { integer: true }), '整数约束生效', '整数');
rejects(() => requiredNumber(11, 'leverage', { max: 10 }), '上限约束生效', '不能大于 10');

check('选填数字没给就是 undefined', optionalNumber(undefined, 'price') === undefined);
check('选填数字空串也算没给', optionalNumber('  ', 'price') === undefined);
check('选填数字 0 不会被当成没给', optionalNumber(0, 'price') === 0);
rejects(() => optionalNumber(0, 'price', { positive: true }), '选填数字的约束照样生效');

check('默认值只在真的没给时用上', numberOr(undefined, 'price', 5) === 5);
check('给了 0 就用 0', numberOr(0, 'price', 5) === 0);

// ---- 字符串 ----
check('字符串去掉前后空白', requiredText('  BTC_USDT ', 'contract') === 'BTC_USDT');
rejects(() => requiredText('   ', 'contract'), '空白字符串算没填', '缺少 contract');
rejects(() => requiredText(undefined, 'contract'), '缺字符串报错', '缺少 contract');
rejects(() => requiredText('x'.repeat(300), 'note', { max: 10 }), '超长字符串被拒', '太长');

// ---- 枚举 ----
check('枚举接受合法值', oneOf('long', 'direction', ['long', 'short']) === 'long');
rejects(() => oneOf('LONG', 'direction', ['long', 'short']), '枚举不认大小写变体', '只能是 long / short');
check('枚举缺省走默认值', oneOfOr(undefined, 'side', ['long', 'short'], 'long') === 'long');
check('枚举空串也走默认值', oneOfOr('', 'side', ['long', 'short'], 'short') === 'short');
rejects(() => oneOfOr('both', 'side', ['long', 'short'], 'long'), '枚举给了不认识的值要报错', '只能是');

// ---- 布尔 ----
check('布尔直接传', flag(true) === true && flag(false) === false);
check('字符串 false 当假', flag('false') === false && flag('0') === false && flag('off') === false);
check('字符串 true 当真', flag('true') === true);

if (failures) process.exit(1);
console.log('✓ 请求参数校验检查通过');
