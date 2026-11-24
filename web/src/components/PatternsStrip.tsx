import { useEffect, useRef, useState } from 'react';
import type { PatternHit } from '../lib/patterns.ts';
import { fmtTime } from '../lib/format.ts';

interface Props {
  hits: PatternHit[];
  /** 最多列多少条。再多只是把这一行撑长，滑出去的部分没人看 */
  limit?: number;
  /**
   * 点一条：把那一根钉到图上。
   *
   * 手机上「去图上找那个箭头」比「点列表」难得多，列表本来就是给人挑的。
   */
  onPick?: (time: number) => void;
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
export default function PatternsStrip({ hits, limit = 10, onPick }: Props) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  /** 刚才是「拖着这一行找」还是「点了一条」：拖完抬手不该顺手选中一条 */
  const draggedRef = useRef(false);

  // 放不下时会横向溢出，但滚动条是藏着的 —— 光靠默认行为鼠标根本滚不动
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hits]);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;

    // 纵向滚轮转成横向：这是鼠标用户唯一顺手的滚法
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      el.scrollLeft += delta;
      e.preventDefault();
    };

    // 按住拖动。卡片上没有点击行为，所以从哪儿按都能拖
    let down = false;
    let startX = 0;
    let startLeft = 0;
    let moved = false;
    const onDown = (e: PointerEvent) => {
      draggedRef.current = false;
      if (e.button !== 0 || el.scrollWidth <= el.clientWidth) return;
      down = true;
      moved = false;
      startX = e.clientX;
      startLeft = el.scrollLeft;
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) > 3) {
        moved = true;
        el.classList.add('dragging');
      }
      if (moved) {
        el.scrollLeft = startLeft - dx;
        e.preventDefault();
      }
    };
    const onUp = () => {
      if (!down) return;
      down = false;
      el.classList.remove('dragging');
      if (moved) draggedRef.current = true;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  if (hits.length === 0) return null;
  const recent = hits.slice(-limit).reverse();
  return (
    <div className={'patterns-strip' + (overflow ? ' scrollable' : '')} ref={stripRef}>
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
          <button
            key={h.time + h.id}
            type="button"
            className={'ps-item ' + h.direction + (onPick ? ' tappable' : '')}
            title={fmtTime(h.time) + ' · ' + h.name + ' · 教科书语义' + dir + ' · ' + tail}
            onClick={() => {
              // 拖完抬手会落到某一条上：那不是「选中」，只是松手的地方
              if (draggedRef.current) { draggedRef.current = false; return; }
              onPick?.(h.time);
            }}
          >
            <span className="ps-time">{fmtTime(h.time)}</span>
            <b className="ps-name">{h.name}</b>
            <span className="ps-dir">{dir}</span>
            {stat && (
              <span className={'ps-stat' + (stat.excess > 0 ? '' : ' flat')}>
                {rate}% / 基准 {base}%
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
