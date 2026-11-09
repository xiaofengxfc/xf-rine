const symbols = ['BTC_USDT','ETH_USDT','SOL_USDT','DOGE_USDT','XRP_USDT','BNB_USDT','LTC_USDT','ADA_USDT'];
const intervals = ['5m','15m','1h','4h'];
for (const s of symbols) {
  const row = [];
  for (const iv of intervals) {
    try {
      const r = await fetch(`http://127.0.0.1:8787/api/levels?contract=${s}&interval=${iv}`);
      const j = await r.json();
      if (!r.ok) { row.push(`${iv}:err`); continue; }
      const sup = j.levels.filter(l => l.role === 'support').length;
      const res = j.levels.filter(l => l.role === 'resistance').length;
      const bl = j.brackets.long, bs = j.brackets.short;
      row.push(`${iv} S${sup}/R${res} 多RR${bl ? bl.riskReward : '-'}${bl && !bl.acceptable ? '✗' : ''} 空RR${bs ? bs.riskReward : '-'}${bs && !bs.acceptable ? '✗' : ''}`);
    } catch (e) { row.push(`${iv}:fail`); }
  }
  console.log(s.padEnd(11), row.join(' | '));
}
