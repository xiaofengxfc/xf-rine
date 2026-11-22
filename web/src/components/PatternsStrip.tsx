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
 * 图上的标记只说明「这一根有形态」—— 具体叫什么、教科书怎么说、实测是什么样，写在这里。
 * 手机上十字线不好停住，这行列表就是那句说明的兜底。
 *
 * 每一条都带上实测数字，是因为 7 万根真实 K 线里没有一个形态在 BH 校正后有正向方向
 * 增量（见 web/src/lib/patterns.ts 文件头）。只写「看涨」会把形态当信号卖，写出来
 * 「62% 胜率 / 基准 49%」这种，看的人自己就能判断该不该当真。
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
      {recent.map((h) => {
        const dir = h.direction === 'bull' ? '看涨' : '看跌';
        const stat = h.stat;
        const rate = stat ? Math.round(stat.win * 100) : null;
        const base = stat ? Math.round(stat.base * 100) : null;
        // 没有增量的形态（tier 0）在列表里要说明白，别让人以为「看涨」是结论
        const verdict = !stat ? '暂无统计' : stat.excess > 0 ? '略高于基准' : '不高于基准';
        const tail = stat
          ? '实测 ' + rate + '% · 基准 ' + base + '% · n=' + stat.n + ' · ' + verdict
          : '暂无统计';
        return (
          <span
            key={h.time + h.id}
            className={'ps-item ' + h.direction}
            title={fmtTime(h.time) + ' · ' + h.name + ' · 教科书语义' + dir + ' · ' + tail}
          >
            <span className="ps-time">{fmtTime(h.time)}</span>
            <b className="ps-name">{h.name}</b>
            <span className="ps-dir">{dir}</span>
            {stat && (
              <span className={'ps-stat' + (stat.excess > 0 ? '' : ' flat')}>
                {rate}% / 基准 {base}%
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
