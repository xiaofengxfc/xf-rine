export const fmtPrice = (p: number, round = 0.1): string => {
  if (!Number.isFinite(p)) return '—';
  const decimals = round >= 1 ? 0 : Math.min(8, Math.max(0, Math.ceil(-Math.log10(round || 1))));
  return p.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

export const fmtPct = (v: number, digits = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%` : '—';

export const fmtUsd = (v: number, digits = 2): string =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';

/**
 * 盈亏这类钱：两位小数会把「亏了 3 厘」写成 -0.00，看着像没亏。
 * 按量级补位数，0.01 以下给四位。
 */
export const fmtMoney = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return fmtUsd(0, 2);
  return fmtUsd(v, abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4);
};

export const compact = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
};

export const fmtTime = (unix: number): string =>
  new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** 只要日期。图上说明「历史最早到哪一天」用 */
export const fmtDate = (unix: number): string =>
  Number.isFinite(unix)
    ? new Date(unix * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '—';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 没有合约元数据时，按价格量级猜一个最小变动位。
 *
 * 本地文件里没有「这个品种一跳多少钱」，交易所那条路有。以前本地模式直接退回 0.1，
 * 拿 BTC 的精度去画 0.074 的 AGT：图上给平价 K 线撑高的门槛变成 0.1，
 * 价格轴被撑到 ±1，整张图压成一条直线。
 *
 * 研究台和日内台的本地图都用这一份，同一个品种两边的小数位数才是同一个。
 */
export const guessPriceRound = (px: number): number => {
  if (!Number.isFinite(px) || px <= 0) return 0.01;
  if (px >= 1000) return 0.1;
  if (px >= 1) return 0.01;
  if (px >= 0.01) return 0.0001;
  return 0.000001;
};

/** 相对时间，新闻列表里用。超过一天直接给日期。 */
export const fmtAgo = (epochMs: number): string => {
  if (!Number.isFinite(epochMs)) return '—';
  const mins = Math.floor((Date.now() - epochMs) / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(epochMs).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};
