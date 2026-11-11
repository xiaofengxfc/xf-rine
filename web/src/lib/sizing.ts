/**
 * 按可用余额的百分比算张数（保证金口径）。
 *
 * 张数 = 可用余额 × 比例 × 杠杆 ÷ (每张名义 × (1 + 费率))
 *
 * 为什么是保证金口径而不是「先算能亏多少」：25/50/75/100 这四个档位，用户脑子里的
 * 意思是「这一单押多少进去」。按风险倒推出来的张数在止损很窄时会离谱地大（止损 0.1%
 * 时 1% 风险要 10 倍权益的名义价值），满杠杆也开不下 —— 那种数字填进输入框只会在
 * 交易所那里被按保证金拒掉。
 *
 * 这里有三个数必须分开写：比例算出来的张数、交易所真能吃的张数、这些张数实际占多少
 * 保证金。界面照实写，不替用户圆。
 */
export interface SizingInput {
  /** 可用余额（USDT） */
  available: number;
  /** 用掉可用余额的百分之几（25 / 50 / 75 / 100） */
  pct: number;
  /** 按哪个价开仓 */
  price: number;
  /** 合约乘数（每张多少币） */
  multiplier: number;
  leverage: number;
  /** 吃单手续费率：交易所按「保证金 + 手续费 ≤ 可用」放行 */
  feeRate: number;
  sizeMin: number;
  /** 0 表示合约没给上限 */
  sizeMax: number;
}

export interface SizingResult {
  /** 这一单准备投进去的保证金 */
  margin: number;
  /** 按比例算出来、取整之前的张数 */
  raw: number;
  /** 真能下的张数（整数，已经夹逼过） */
  size: number;
  /** 可用余额全押能开多少张（保证金 + 手续费口径） */
  affordable: number;
  /** 张数对应的名义价值 */
  notional: number;
  /** 张数实际占用的保证金（不含手续费） */
  usedMargin: number;
  /** 这一单的吃单手续费 */
  fee: number;
  /** 被谁夹住了：'' 正常，'afford' 余额不够一手，'max' 撞合约上限，'min' 提到最小一手 */
  clamped: '' | 'afford' | 'max' | 'min';
}

export function percentSizing(i: SizingInput): SizingResult {
  const pct = Math.min(100, Math.max(0, i.pct));
  const feeRate = Math.max(0, i.feeRate);
  const avail = Math.max(0, i.available);
  const notionalPer = i.multiplier > 0 && i.price > 0 ? i.multiplier * i.price : 0;
  // 每张要占的钱：保证金 + 手续费。用这个分母，按比例算出来的张数才不会刚好被手续费顶爆
  const perSize = notionalPer > 0 && i.leverage > 0
    ? notionalPer / i.leverage + notionalPer * feeRate
    : 0;
  const margin = avail * (pct / 100);
  const affordable = perSize > 0 ? Math.floor(avail / perSize) : 0;
  const raw = perSize > 0 ? margin / perSize : 0;

  let size = Math.floor(Math.max(0, raw));
  let clamped: SizingResult['clamped'] = '';
  if (size > affordable) {
    size = affordable;
    clamped = 'afford';
  }
  if (i.sizeMax > 0 && size > i.sizeMax) {
    size = i.sizeMax;
    clamped = 'max';
  }
  if (i.sizeMin > 0 && size < i.sizeMin) {
    if (affordable >= i.sizeMin) {
      // 余额够一手，但按这个比例算不到一手：给到最小一手，并说明是被最小下单量顶上去的
      size = i.sizeMin;
      clamped = 'min';
    } else {
      size = 0;
      clamped = 'afford';
    }
  }

  const notional = size * notionalPer;
  return {
    margin,
    raw,
    size,
    affordable,
    notional,
    usedMargin: i.leverage > 0 ? notional / i.leverage : 0,
    fee: notional * feeRate,
    clamped,
  };
}
