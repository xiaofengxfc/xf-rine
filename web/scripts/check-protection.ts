/**
 * 命令行体检：保护单的到期与裸仓判断（web/src/lib/protective.ts）。
 * 用法： pnpm -F server exec tsx ../web/scripts/check-protection.ts
 *
 * 为什么单独查这一层：止损止盈到期是交易所自己撤单，页面以前完全不读这个字段。
 * 这一层判错的后果是静默裸仓 —— 界面上必须说清楚，所以它的逻辑要能单独验。
 */
import {
  bracketOf, fmtLeft, protectionState, triggerKind, type Dir,
} from '../src/lib/protective.ts';
import type { PriceOrder } from '../src/lib/api.ts';

const failures: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };

function order(rule: number, expiresAt: number, direction: '' | 'long' | 'short' = 'long'): PriceOrder {
  return {
    id: 'p1', contract: 'BTC_USDT', direction,
    triggerPrice: 100, triggerRule: rule, size: 0,
    protective: true, reduceOnly: false, closeAll: false,
    createTime: 1_700_000_000, expiresAt,
  };
}

const now = 1_800_000_000_000;

// ---- 1) 剩余时长：分钟、小时、天、过期，以及读不出到期时刻 ----
check(fmtLeft(30 * 60_000).includes('30 分钟'), '时长：半小时该显示 30 分钟，得到 ' + fmtLeft(30 * 60_000));
check(fmtLeft(5 * 3_600_000 + 12 * 60_000).includes('5 小时'), '时长：5 小时 12 分显示不对：' + fmtLeft(5 * 3_600_000 + 12 * 60_000));
check(fmtLeft(30 * 3_600_000).includes('天'), '时长：超过一天该按天显示，得到 ' + fmtLeft(30 * 3_600_000));
check(fmtLeft(-1000) === '已过期', '时长：负数该说已过期，得到 ' + fmtLeft(-1000));

// ---- 2) 裸仓：一张保护都没有时必须报 naked ----
{
  const st = protectionState({ stop: null, target: null }, now);
  check(st.naked === true, '裸仓：没有保护单却没报 naked');
  check(st.armed === false, '裸仓：不该报 armed');
  check(st.expiresAt === 0 && st.left === '', '裸仓：没有单就不该编一个到期时间');
}

// ---- 3) 只有止盈也算有保护，但到期要按最近的那张算 ----
{
  const stop = order(2, now / 1000 + 5 * 3600);
  const target = order(1, now / 1000 + 90 * 60);
  const st = protectionState({ stop, target }, now);
  check(st.armed === true && st.naked === false, '有保护：挂了单却报裸仓');
  check(st.expiresAt === target.expiresAt, '有保护：到期该取更早的那张，得到 ' + st.expiresAt);
  check(st.urgent === false, '有保护：还剩 90 分钟不该报 urgent');
}

// ---- 4) 15 分钟以内要报 urgent：这时候再等就来不及补挂了 ----
{
  const st = protectionState({ stop: order(2, now / 1000 + 10 * 60), target: null }, now);
  check(st.urgent === true, '临期：只剩 10 分钟却没报 urgent');
}

// ---- 5) 读不出到期时刻：不能当成马上到期 ----
{
  const st = protectionState({ stop: order(2, 0), target: null }, now);
  check(st.armed === true, '无到期：挂了单却没报 armed');
  check(st.urgent === false, '无到期：到期时刻为 0 不该报 urgent');
  check(st.left === '', '无到期：不该编一段剩余时间，得到 ' + st.left);
}

// ---- 6) 止损 / 止盈的判定：Gate 的 rule 只看价格走向 ----
{
  check(triggerKind(order(1, 0), 'long' as Dir) === 'target', '判定：多头 rule 1 是止盈');
  check(triggerKind(order(2, 0), 'long' as Dir) === 'stop', '判定：多头 rule 2 是止损');
  check(triggerKind(order(1, 0, 'short'), 'short' as Dir) === 'stop', '判定：空头 rule 1 是止损');
  check(triggerKind(order(2, 0, 'short'), 'short' as Dir) === 'target', '判定：空头 rule 2 是止盈');
}

// ---- 7) bracketOf 只认自己这一边、这个合约 ----
{
  const rows: PriceOrder[] = [
    // 多头：rule 2 = 止损，rule 1 = 止盈
    { ...order(2, 0, 'long'), id: 'a', contract: 'BTC_USDT' },
    { ...order(1, 0, 'long'), id: 'b', contract: 'BTC_USDT' },
    // 空头：rule 1 = 止损（价格涨上去才平），这张没有对应的止盈
    { ...order(1, 0, 'short'), id: 'c', contract: 'BTC_USDT' },
    // 别的合约：同一套 rule 也不能串过来
    { ...order(2, 0, 'long'), id: 'd', contract: 'ETH_USDT' },
  ];
  const b = bracketOf(rows, 'BTC_USDT', 'long');
  check(b.stop?.id === 'a', '归属：多头止损取错了，得到 ' + b.stop?.id);
  check(b.target?.id === 'b', '归属：多头止盈取错了，得到 ' + b.target?.id);
  const s = bracketOf(rows, 'BTC_USDT', 'short');
  check(s.stop?.id === 'c', '归属：空头止损取错了，得到 ' + s.stop?.id);
  check(s.target === null, '归属：空头没有止盈，不该凭空给一张');
}

if (failures.length === 0) {
  console.log('自检（保护单到期 / 裸仓 / 判定 / 归属）：全部通过');
} else {
  for (const f of failures) console.log('  ✗ ' + f);
}
process.exit(failures.length === 0 ? 0 : 1);
