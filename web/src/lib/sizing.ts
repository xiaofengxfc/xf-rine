/**
 * 按风险算仓位。
 *
 * 风险预算 ÷ 每张到止损亏多少钱 = 想要的张数。问题是止损很窄的时候（也就是盈亏比很高），
 * 这个数字会大得离谱：止损 0.1% 的时候，1% 风险要的是 10 倍权益的名义价值，
 * 满杠杆也未必开得下。原来直接把 wanted 填进输入框，点下去必然被交易所按保证金拒掉。
 *
 * 所以这里一次给出三个数：想要多少、真能下多少、真能下的那些张数实际亏多少。
 * 界面照实写，不替用户猜。
 */
export interface SizingInput {
  /** 这一单准备亏多少（可用余额 × 风险百分比） */
  budget: number;
  /** 按哪个价开仓 */
  price: number;
  /** 止损价。0 表示这一单没有止损，没法按风险算 */
  stop: number;
  multiplier: number;
  /** 可用余额 */
  available: number;
  /** 当前杠杆 */
  leverage: number;
  /** 吃单手续费率，交易所按「保证金 + 手续费 ≤ 可用」放行 */
  feeRate: number;
  /** 这个合约允许的最大杠杆 */
  leverageMax: number;
  sizeMin: number;
  /** 0 表示合约没给上限 */
  sizeMax: number;
}

export interface SizingResult {
  /** 每张打到止损亏多少 USDT */
  perContract: number;
  /** 风险预算本身 */
  budget: number;
  /** 按风险算想要的张数 */
  wanted: number;
  /** 受保证金和最大下单量夹住之后真能下的张数 */
  feasible: number;
  /** 按当前杠杆最多能下多少张 */
  affordable: number;
  /** 可下张数全打到止损会亏多少 */
  riskAtFeasible: number;
  /** 想开满 wanted 张至少要几倍杠杆；Infinity 表示这账户怎么都不够 */
  leverageNeeded: number;
  /** 需要的杠杆超过合约上限：这套止损下按风险开不满 */
  overMaxLeverage: boolean;
  /** 确实被保证金卡住了（不是被止损本身算出来的） */
  cappedByMargin: boolean;
}

export function riskSizing(i: SizingInput): SizingResult {
  const feeRate = Math.max(0, i.feeRate);
  const budget = Math.max(0, i.budget);
  const notionalPer = i.multiplier > 0 && i.price > 0 ? i.multiplier * i.price : 0;
  const perContract = notionalPer > 0 && i.stop > 0 ? Math.abs(i.price - i.stop) * i.multiplier : 0;
  const wanted = perContract > 0 ? Math.floor(budget / perContract) : 0;

  const affordable = notionalPer > 0 && i.leverage > 0
    ? Math.max(0, Math.floor(i.available / (1 / i.leverage + feeRate) / notionalPer))
    : 0;
  const cap = i.sizeMax > 0 ? Math.min(affordable, i.sizeMax) : affordable;
  const feasible = Math.min(wanted, cap);

  const needNotional = wanted * notionalPer;
  const share = needNotional > 0 && i.available > 0 ? i.available / needNotional - feeRate : 0;
  const lev = share > 0 ? 1 / share : Infinity;
  const leverageNeeded = Number.isFinite(lev) ? Math.ceil(lev * 100) / 100 : Infinity;

  return {
    perContract,
    budget,
    wanted,
    feasible,
    affordable,
    riskAtFeasible: feasible * perContract,
    leverageNeeded,
    overMaxLeverage: leverageNeeded > i.leverageMax,
    cappedByMargin: wanted > 0 && feasible < wanted,
  };
}
