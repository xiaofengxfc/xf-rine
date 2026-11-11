/**
 * 横向扫一批合约：每个合约在每个周期上认出几条位、最近的那条离现价多远、平均守住率多少。
 * 用之前先让服务跑起来（`pnpm start`，或者页面开着）。
 * 用法： node server/scripts/check-balance.mjs
 */
const symbols = ['BTC_USDT','ETH_USDT','SOL_USDT','DOGE_USDT','XRP_USDT','BNB_USDT','LTC_USDT','ADA_USDT'];
const intervals = ['5m','15m','1h','4h'];
console.log('合约'.padEnd(11), intervals.map((i) => i.padEnd(22)).join(''));
for (const s of symbols) {
  const row = [];
  for (const iv of intervals) {
    try {
      const r = await fetch(`http://127.0.0.1:8787/api/levels?contract=${s}&interval=${iv}`);
      const j = await r.json();
      if (!r.ok) { row.push(`${iv}:err`.padEnd(22)); continue; }
      const sup = j.levels.filter((l) => l.role === 'support').length;
      const res = j.levels.filter((l) => l.role === 'resistance').length;
      // 平均守住率：判不出样本的位给的是保守下界 0.25，所以这个数偏低是正常的
      const rate = j.levels.length
        ? j.levels.reduce((a, l) => a + l.holdRate, 0) / j.levels.length
        : 0;
      // 最近的那条位离现价几个 ATR：小于 1 说明现价正贴着一个位在走
      const near = j.levels.length
        ? Math.min(...j.levels.map((l) => Math.abs(l.distAtr)))
        : Infinity;
      row.push(`${iv} S${sup}/R${res} 守${Math.round(rate * 100)}% 近${Number.isFinite(near) ? near.toFixed(1) + 'A' : '-'}`.padEnd(22));
    } catch {
      row.push(`${iv}:fail`.padEnd(22));
    }
  }
  console.log(s.padEnd(11), row.join(''));
}
