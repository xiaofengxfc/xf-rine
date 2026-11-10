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

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

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
