/**
 * 离线体检：交易所报错翻成人话（server/src/routes.ts 的 translate）。
 *
 * 这里只钉一件事：哪些错误会变成用户真的看得懂、照着做就行的那句话。
 * 尤其是密钥没有合约交易写权限 —— 它读行情是好的，页面上一切正常，
 * 只有到点下单才被拒，翻错了用户就只能对着英文猜。
 *
 * 用法：pnpm check:errors
 */
import { translate } from '../src/routes.js';
import { GateError } from '../src/gate/rest.js';

let failed = 0;
let total = 0;
function check(name: string, got: unknown, want: unknown): void {
  total += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`
    + (ok ? '' : `\n     得到 ${JSON.stringify(got)}\n     期望 ${JSON.stringify(want)}`));
}

/** 翻译结果里我们要核对的几样东西 */
const shape = (e: unknown): { label: string; status: number; hasSteps: boolean; hasEnglish: boolean } => {
  const g = e as GateError;
  const label = g instanceof GateError ? g.label : '(不是 GateError)';
  const status = g instanceof GateError ? g.status : 0;
  const text = g instanceof GateError ? g.detail : '';
  return {
    label,
    status,
    // 说清楚去哪儿改：改权限这四个字必须在里面
    hasSteps: /API 管理/.test(text) && /合约交易/.test(text),
    // 不该再把交易所那句英文原样甩给用户
    hasEnglish: /does not have futures write permission|Request API key/i.test(text),
  };
};

// ---- 1. label 是 READ_ONLY（Gate 的写法）----
check(
  'READ_ONLY 翻成「没有合约交易写权限」并给出改法',
  shape(translate(new GateError(403, 'READ_ONLY', 'Request API key does not have futures write permission'))),
  { label: 'KEY_NO_WRITE', status: 403, hasSteps: true, hasEnglish: false },
);

// ---- 2. 有的接口不带 label，Gate 的 message 会被顶到 label 上（见 gate/rest.ts）----
check(
  '没有 label 时按英文原文也能认出来',
  shape(translate(new GateError(403, 'Request API key does not have futures write permission', 'Request API key does not have futures write permission'))),
  { label: 'KEY_NO_WRITE', status: 403, hasSteps: true, hasEnglish: false },
);

// ---- 3. 别的权限问题不能被误认成写权限（IP 白名单最常见）----
check(
  'IP 白名单不是写权限问题，原样保留',
  shape(translate(new GateError(403, 'IP_FORBIDDEN', 'your ip is not allowed'))),
  { label: 'IP_FORBIDDEN', status: 403, hasSteps: false, hasEnglish: false },
);

// ---- 4. 余额不够那种要按原样往上走（由 explainMargin 去解释）----
check(
  '保证金不够不在这里改',
  shape(translate(new GateError(400, 'MARGIN_NOT_ENOUGH', 'margin 6180.18 while available 974.21'))),
  { label: 'MARGIN_NOT_ENOUGH', status: 400, hasSteps: false, hasEnglish: false },
);

// ---- 5. 不是 Gate 的错误原样返回 ----
const plain = new Error('boom');
check('非 GateError 原样返回', translate(plain) === plain, true);

if (failed > 0) {
  console.error(`\n✗ ${failed} 项失败，${total - failed} 项通过`);
  process.exit(1);
}
console.log(`\n✓ 报错翻译全部通过（${total} 项）`);
