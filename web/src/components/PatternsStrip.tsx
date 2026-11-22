import type { PatternHit } from '../lib/patterns.ts';
import { fmtTime } from '../lib/format.ts';

interface Props {
  hits: PatternHit[];
  /** 最多列多少条。再多只是把这一行撑长，滑出去的部分没人看 */
  limit?: number;
}

/**
 * 最近识别到的形态。
 *
 * 图上的箭头只说明「这一根有形态」，具体叫什么、看涨还是看跌写在这里 ——
 * 手机上十字线不好停住，这行列表就是那句说明的兜底。
 *
 * 新的排在前面：看盘的人先关心刚刚那根是什么，不是三天前那根。
 * 一条都没有时整块不渲染，不留一条空带子占着图的高度。
 */
export default function PatternsStrip({ hits, limit = 10 }: Props) {
  if (hits.length === 0) return null;
  const recent = hits.slice(-limit).reverse();
  return (
    <div className="patterns-strip">
      <span className="ps-label">最近形态</span>
      {recent.map((h) => (
        <span
          key={h.time + h.id}
          className={`ps-item ${h.direction}`}
          title={`${fmtTime(h.time)} · ${h.name} · ${h.direction === 'bull' ? '看涨' : '看跌'}`}
        >
          <span className="ps-time">{fmtTime(h.time)}</span>
          <b className="ps-name">{h.name}</b>
          <span className="ps-dir">{h.direction === 'bull' ? '看涨' : '看跌'}</span>
        </span>
      ))}
    </div>
  );
}
