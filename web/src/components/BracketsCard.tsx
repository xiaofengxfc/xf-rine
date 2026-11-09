import type { Bracket } from '../lib/api.ts';
import { fmtPrice, fmtPct, fmtUsd } from '../lib/format.ts';

interface Props {
  long: Bracket | null;
  short: Bracket | null;
  priceRound: number;
  multiplier: number;
  equity: number;
  riskPercent: number;
  onUse: (b: Bracket) => void;
}

export default function BracketsCard({ long, short, priceRound, multiplier, equity, riskPercent, onUse }: Props) {
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
            const riskUsd = equity * (riskPercent / 100);
            void label;
            const perContractRisk = (b.riskPct / 100) * b.entry * multiplier;
            const contracts = perContractRisk > 0 ? Math.floor(riskUsd / perContractRisk) : 0;
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
                  <dt>入场</dt><dd>{fmtPrice(b.entry, priceRound)}</dd>
                  <dt>止损</dt><dd style={{ color: 'var(--down)' }}>{fmtPrice(b.stop, priceRound)} <span className="dim">({fmtPct(-b.stopDistancePct, 2)})</span></dd>
                  <dt>止盈</dt><dd style={{ color: 'var(--up)' }}>{fmtPrice(b.target, priceRound)} <span className="dim">({fmtPct(b.targetDistancePct, 2)})</span></dd>
                  <dt>可担亏损</dt><dd>{fmtUsd(riskUsd)} USDT</dd>
                  <dt>对应张数</dt><dd>{equity <= 0 ? <span className="dim">未读到权益</span> : contracts > 0 ? contracts + ' 张' : <span className="dim">余额不足</span>}</dd>
                </dl>
                <div className="br-src">
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
