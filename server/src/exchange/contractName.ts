/**
 * 合约名写得像不像合约名。
 *
 * 只挡住「明显不是合约名」的输入：少了下划线的 BTC、带空格或冒号的。
 * 这种名字后面一定会被交易所回 CONTRACT_NOT_FOUND，而那条错误会被翻成
 * 「这个合约在模拟盘没有上市」—— 把「名字写错」讲成「没上市」。
 *
 * 更糟的一条实测：带空格的合约名会一路走到签名环节，交易所回 INVALID_SIGNATURE，
 * 于是输入错误被报成「密钥不对」，用户会去重新填 API key。
 *
 * 不能按 ASCII 白名单洗：Gate 上有 牛逼_USDT 这种中文合约（见 gate/market.ts）。
 */
export function contractNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (!name) return '没有填合约';
  if (/[\s:/\u0000-\u001f\u007f]/.test(name)) {
    return '合约名里不能有空格或冒号，现在的写法是「' + name + '」';
  }
  if (!name.includes('_')) {
    return '合约名要写成 BTC_USDT 这种形式（中间带下划线），现在填的是「' + name + '」';
  }
  return null;
}
