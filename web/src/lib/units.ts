/**
 * 张和币的换算。
 *
 * 交易所下单接口只认币数量（adapter 里 qty = 张 × 每张币数），服务端内部统一折成「张」往下传。
 * 界面按币输入、按张记账，两个单位的接口只有这一个文件 —— 别在组件里再写一份除法。
 *
 * 为什么不就地写 Math.floor(币 / 乘数)：0.0003 / 0.0001 这类除法会带出 2.9999999999999996 的尾巴，
 * 直接 floor 就把 3 张算成 2 张 —— 少开一张，看着像程序吞了钱。sizing 里的 floorToSizeStep
 * 是按「步进的整数倍」取整并带容差的，换算一律走它。
 */
import { floorToSizeStep, sizeDecimals } from './sizing.ts';

/**
 * 币的下单步进。
 *
 * 交易所给的是「1 张 = mult 币」和「1 张的步进 = sizeStep」，乘起来就是币的步进：
 * mult = 0.0001、sizeStep = 1 时，币步进 0.0001；这正好等于交易所的 volumePlace 位数，
 * 因为服务端的 size_step 本来就是用 10^-volumePlace / mult 反推出来的。
 */
export function coinStepOf(multiplier: number, sizeStep: number): number {
  if (!(multiplier > 0) || !(sizeStep > 0)) return 0;
  return Number((multiplier * sizeStep).toFixed(12));
}

/** 币数量要写到小数点后几位。读不到乘数时按 0 位，不瞎给精度 */
export function coinDecimalsOf(multiplier: number, sizeStep: number): number {
  const step = coinStepOf(multiplier, sizeStep);
  return step > 0 ? sizeDecimals(step) : 0;
}

/**
 * 币 → 张。向下取整到张的步进：宁可少开一点，也不越过用户写的那个币数。
 * 不够一张返回 0，由调用方去拦 —— 不替用户四舍五入成一张。
 */
export function coinsToContracts(coins: number, multiplier: number, sizeStep = 1): number {
  if (!(coins > 0) || !(multiplier > 0) || !Number.isFinite(coins)) return 0;
  return floorToSizeStep(coins / multiplier, sizeStep > 0 ? sizeStep : 1);
}

/** 张 → 币。切掉浮点尾巴（12 张 × 0.001 是 0.012000000000000002） */
export function contractsToCoins(contracts: number, multiplier: number): number {
  if (!Number.isFinite(contracts) || !(multiplier > 0)) return 0;
  const coin = contracts * multiplier;
  return Number.isFinite(coin) ? Number(coin.toFixed(12)) : 0;
}

/**
 * 币数的纯数字串，用来写进输入框：不带千分位、不带科学计数法、末尾不留零。
 * 0 和非数返回空串 —— 输入框空着比写个 0 好。
 */
export function coinsToInput(coins: number, decimals: number): string {
  if (!Number.isFinite(coins) || !(coins > 0)) return '';
  const digits = Math.max(0, Math.min(12, Math.trunc(decimals) || 0));
  const text = coins.toFixed(digits);
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed || '0';
}

/**
 * 币数的显示串，带千分位。
 *
 * 不走 toLocaleString 的四舍五入：交易所最小的币步进可能低到 1e-12，
 * toLocaleString 遇到极小数会直接写成 0，看着像这一单不用花钱。
 */
export function fmtCoins(coins: number, decimals: number): string {
  if (!Number.isFinite(coins)) return '—';
  const text = coinsToInput(coins, decimals) || '0';
  const [whole, fraction] = text.split('.');
  const grouped = Number(whole || '0').toLocaleString('en-US');
  return fraction ? grouped + '.' + fraction : grouped;
}
