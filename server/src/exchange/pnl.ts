/** Pure daily realized-PnL aggregation for exchange history records. */

interface GateAccountBookEntry {
  change?: unknown;
  time?: unknown;
  type?: unknown;
}

interface BitgetFill {
  createdTime?: unknown;
  execPnl?: unknown;
  tradeSide?: unknown;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sumGateRealisedPnl(
  records: GateAccountBookEntry[],
  fromMs: number,
  toMs: number,
): number {
  return records.reduce((total, record) => {
    const atMs = finiteNumber(record.time) * 1000;
    if (record.type !== 'pnl' || atMs < fromMs || atMs >= toMs) return total;
    return total + finiteNumber(record.change);
  }, 0);
}

export function sumBitgetRealisedPnl(
  fills: BitgetFill[],
  fromMs: number,
  toMs: number,
): number {
  return fills.reduce((total, fill) => {
    const atMs = finiteNumber(fill.createdTime);
    const tradeSide = String(fill.tradeSide ?? '').toLowerCase();
    const isClose = tradeSide === 'close' || tradeSide.startsWith('close_');
    if (!isClose || atMs < fromMs || atMs >= toMs) return total;
    return total + finiteNumber(fill.execPnl);
  }, 0);
}
