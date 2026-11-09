export const fmtPrice = (p: number, round = 0.1): string => {
  if (!Number.isFinite(p)) return '—';
  const decimals = round >= 1 ? 0 : Math.min(8, Math.max(0, Math.ceil(-Math.log10(round || 1))));
  return p.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

export const fmtPct = (v: number, digits = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%` : '—';

export const fmtUsd = (v: number, digits = 2): string =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';

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
