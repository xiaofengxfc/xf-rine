import { fmtPct, fmtPrice } from '../lib/format.ts';
import type { Level } from '../lib/api.ts';

interface Props {
  levels: Level[];
  manual: number[];
  price: number;
  priceRound: number;
  atr: number;
}

export default function LevelsStrip({ levels, manual, price, priceRound, atr }: Props) {
  const manualSet = new Set(manual.map((p) => p.toFixed(6)));
  const manualOnly = manual.filter((p) => !levels.some((l) => Math.abs(l.price - p) < atr * 0.3));

  return (
    <div className="levels-strip">
      <div className="lv" style={{ color: 'var(--text-2)', minWidth: 96 }}>
        <div className="r1"><span className="px" style={{ fontSize: 11 }}>ATR</span></div>
        <div className="meta"><span>{fmtPrice(atr, priceRound)}</span></div>
        <div className="meta"><span>{(atr / (price || 1) * 100).toFixed(2)}% 波动</span></div>
      </div>

      {levels.length === 0 && <div className="empty" style={{ flex: 1 }}>这个周期还没有识别出够强的位，换个周期或调低最小强度</div>}

      {levels.map((lv) => (
        <button
          key={`${lv.role}-${lv.price}`}
          className={`lv ${lv.role === 'support' ? 'sup' : 'res'}`}
          title={`触及 ${lv.touches} 次 · 假突破 ${lv.failures} 次 · 成交量占比 ${(lv.volumeRatio * 100).toFixed(0)}% · 区间 ${fmtPrice(lv.zoneLow, priceRound)} - ${fmtPrice(lv.zoneHigh, priceRound)}`}
        >
          <div className="r1">
            <span className="px">{fmtPrice(lv.price, priceRound)}</span>
            <span className="tag">{lv.role === 'support' ? '支撑' : '阻力'}</span>
          </div>
          <div className="meta">
            <span>{fmtPct(lv.distancePct, 2)}</span>
            <span>强度 {Math.round(lv.strength)}</span>
          </div>
          <div className="meta">
            <span>{lv.touches} 次触及</span>
            <span>假破 {lv.failures}</span>
          </div>
          <i className="bar" style={{ width: `${lv.strength}%` }} />
        </button>
      ))}

      {manualOnly.length > 0 && manualOnly.map((p) => (
        <div
          key={`m-${p}`}
          className="lv"
          style={{ color: '#8aa4ff', minWidth: 104 }}
          title="你手动画的水平线"
        >
          <div className="r1">
            <span className="px">{fmtPrice(p, priceRound)}</span>
            <span className="tag">手动</span>
          </div>
          <div className="meta">
            <span>{fmtPct(((p - price) / (price || 1)) * 100, 2)}</span>
            <span>{manualSet.size} 条</span>
          </div>
        </div>
      ))}
    </div>
  );
}
