import { fmtPct, fmtPrice } from '../lib/format.ts';
import type { ResearchAnalysis } from '../lib/api.ts';

interface Props {
  a: ResearchAnalysis;
  priceRound: number;
}

/**
 * 分析结果顶部的三张卡：标的、最近关键位（方向化摘要）、位置统计。
 *
 * 数字的口径写在卡片里，不靠图例解释：
 *   触及概率 = 未来若干根走到这里的概率（模型区分度强）
 *   守住概率 = 走到之后反弹而不是跌穿的概率（校准好、区分度弱）
 */
export default function ResearchCards({ a, priceRound }: Props) {
  const s = a.summary;
  const nearest = s.nearest;
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.round(v * 100) + '%');
  const eng = a.engine;
  const tfLabel = a.tf_label || a.tf;

  return (
    <div className="stat-cards">
      <div className="stat-card">
        <div className="stat-k">标的</div>
        <div className="stat-name">{a.symbol_label || a.symbol}</div>
        <div className="stat-code">{tfLabel} · {a.data_bars} 根 K 线</div>
        <div className="stat-price">
          <span>{fmtPrice(a.current_price, priceRound)}</span>
          <span className={`chg-badge ${a.change_pct >= 0 ? 'up' : 'down'}`}>{fmtPct(a.change_pct, 2)}</span>
        </div>
        <div className="stat-code">
          ATR {fmtPrice(eng.atr, priceRound)}
          {eng.atr_pct !== null ? ` · ${eng.atr_pct.toFixed(2)}% 波动` : ''}
          {' · '}{a.zones.length} 个位
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-k">最近关键位 · {s.direction_label}</div>
        {nearest ? (
          <>
            <div className="stat-headline">{s.headline}</div>
            <div className="stat-grid">
              <div className="stat-cell"><div className="v">{pct(nearest.p_touch)}</div><div className="l">触及概率</div></div>
              <div className="stat-cell"><div className="v">{pct(nearest.p_hold)}</div><div className="l">守住概率</div></div>
              <div className="stat-cell"><div className="v">{nearest.n_events}</div><div className="l">历史被测试</div></div>
              <div className="stat-cell"><div className="v">{s.trend_label}</div><div className="l">趋势</div></div>
            </div>
            <div className="stat-detail">{s.trend_detail}</div>
          </>
        ) : (
          <>
            <div className="stat-headline">{s.headline}</div>
            <div className="stat-detail">趋势{s.trend_label} · {s.trend_detail}</div>
          </>
        )}
      </div>

      <div className="stat-card">
        <div className="stat-k">关键位</div>
        <div className="stat-row"><span>最近支撑</span><span className="s">{fmtPx(nearestSide(a, 'support'), priceRound)}</span></div>
        <div className="stat-row"><span>最近压力</span><span className="r">{fmtPx(nearestSide(a, 'resistance'), priceRound)}</span></div>
        <div className="stat-row"><span>关键位数</span><span>{a.zones.length}</span></div>
        <div className="stat-row"><span>共振周期</span><span>{a.mtf_zones.length ? a.mtf_zones.map((m) => m.tf_label).join(' / ') : '无'}</span></div>
        <div className="stat-row"><span>引擎</span><span>{(eng.prob_ready ? 'V3 融合 + 概率' : 'V3 融合（无概率）')}</span></div>
      </div>
    </div>
  );
}

const fmtPx = (v: number | null, round: number): string => (v === null ? '—' : fmtPrice(v, round));

/** 某一侧离现价最近的中枢价 */
function nearestSide(a: ResearchAnalysis, role: 'support' | 'resistance'): number | null {
  const pool = a.zones.filter((z) => z.zone_type === role);
  if (pool.length === 0) return null;
  return pool.reduce((x, y) => (Math.abs(y.distance_atr) < Math.abs(x.distance_atr) ? y : x)).center;
}
