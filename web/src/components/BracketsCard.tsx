import type { Bracket, EntryKind } from '../lib/api.ts';
import { fmtPrice, fmtPct, fmtUsd } from '../lib/format.ts';
import { riskSizing } from '../lib/sizing.ts';

interface Props {
  long: Bracket | null;
  short: Bracket | null;
  priceRound: number;
  multiplier: number;
  /** 账户权益。没传可用余额时退回它，宁可少算也不显示 0 */
  equity: number;
  /**
   * 可用余额。风险预算和「开不开得下」都按它算，
   * 和下单面板的「可用 × 风险 %」是同一个口径，两处数字才不会打架。
   */
  available?: number;
  /** 吃单手续费率：交易所按「保证金 + 手续费 ≤ 可用」放行，不算手续费会高估张数 */
  feeRate?: number;
  riskPercent: number;
  /** 这个合约允许的最大杠杆：按风险算出来的张数到底开不开得下，要看它 */
  leverageMax: number;
  onUse: (b: Bracket) => void;
}

/** 入场价的来历，一行字。用词跟着 entryKind 走，不统一写成「入场」把人绕晕 */
const kindText = (k: EntryKind) => (k === 'level' ? '回踩' : k === 'range' ? '区间中位' : k === 'atr' ? 'ATR 回撤' : '现价');

export default function BracketsCard({
  long, short, priceRound, multiplier, equity, available, feeRate = 0, riskPercent, leverageMax, onUse,
}: Props) {
  const rows: { b: Bracket; cls: string; label: string }[] = [];
  if (long) rows.push({ b: long, cls: 'long', label: '做多方案' });
  if (short) rows.push({ b: short, cls: 'short', label: '做空方案' });

  return (
    <section className="card">
      <div className="card-head">
        <h3>自动止盈止损</h3>
        <span className="dim" style={{ fontSize: 10 }}>风险单笔 {riskPercent}%</span>
      </div>
      <div className="card-body">
        {rows.length === 0 && <div className="empty">还没有足够强的位，无法给出方案</div>}
        <div className="brackets">
          {rows.map(({ b, cls, label }) => {
            const base = available ?? equity;
            const riskUsd = base * (riskPercent / 100);
            // 按风险算张数，再按合约能给的最大杠杆看这个张数开不开得下。
            // 止损很窄（盈亏比很高）时想要的张数会大得离谱，直接写出来会让人以为能下。
            const sizing = riskSizing({
              budget: riskUsd,
              price: b.entry,
              stop: b.stop,
              multiplier,
              available: base,
              leverage: leverageMax,
              feeRate,
              leverageMax,
              sizeMin: 1,
              sizeMax: 0,
            });
            return (
              <div key={b.direction} className={`br ${cls}`}>
                <div className="br-head">
                  <span className="br-dir" style={{ color: cls === 'long' ? 'var(--up)' : 'var(--down)' }}>{label}</span>
                  <span className="br-rr" style={{ color: b.acceptable ? 'var(--up)' : 'var(--warn)' }}>
                    盈亏比 {b.riskReward.toFixed(2)}
                  </span>
                </div>
                {!b.acceptable && (
                  <div className="br-src" style={{ color: 'var(--warn)' }}>
                    盈亏比低于 {b.minRR}，这一侧结构不支持，不建议开
                  </div>
                )}
                <dl className="br-rows">
                  <dt>{kindText(b.entryKind)}</dt>
                  <dd>
                    {fmtPrice(b.entry, priceRound)}
                    {b.entryKind !== 'market' && (
                      <span className="dim">
                        {' '}距现价 {fmtPct(b.entryDistancePct, 2)}（{b.entryDistanceAtr.toFixed(2)} ATR）
                      </span>
                    )}
                  </dd>
                  <dt>止损</dt><dd style={{ color: 'var(--down)' }}>{fmtPrice(b.stop, priceRound)} <span className="dim">({fmtPct(-b.stopDistancePct, 2)})</span></dd>
                  <dt>止盈</dt><dd style={{ color: 'var(--up)' }}>{fmtPrice(b.target, priceRound)} <span className="dim">({fmtPct(b.targetDistancePct, 2)})</span></dd>
                  <dt>可担亏损</dt><dd>{fmtUsd(riskUsd)} USDT</dd>
                  <dt>对应张数</dt>
                  <dd>
                    {!(multiplier > 0)
                      ? <span className="dim">未读到合约信息</span>
                      : base <= 0
                        ? <span className="dim">未读到可用余额</span>
                        : sizing.feasible > 0
                          ? (sizing.cappedByMargin ? `${sizing.feasible} 张（按风险要 ${sizing.wanted}）` : `${sizing.feasible} 张`)
                          : <span className="dim">余额不足</span>}
                  </dd>
                </dl>
                {sizing.overMaxLeverage && (
                  <div className="br-src" style={{ color: 'var(--warn)' }}>
                    止损只有 {b.stopDistancePct.toFixed(2)}%，按风险要 {sizing.wanted} 张；
                    满 {leverageMax} 倍杠杆也只开得下 {sizing.feasible} 张。想按风险开满只能放宽止损，或者接受更小的风险。
                  </div>
                )}
                <div className="br-src">
                  <div>入场 · {b.entrySource}</div>
                  <div>止损 · {b.stopSource}</div>
                  <div>止盈 · {b.targetSource}</div>
                </div>
                <button className="btn ghost" style={{ padding: '6px 0' }} onClick={() => onUse(b)}>套用到下单面板</button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
