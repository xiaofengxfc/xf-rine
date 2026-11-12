import { useEffect, useRef, useState } from 'react';
import { fmtPct, fmtPrice } from '../lib/format.ts';
import type { Zone } from '../lib/api.ts';

interface Props {
  zones: Zone[];
  manual: number[];
  price: number;
  priceRound: number;
  atr: number;
}

/**
 * 档位带。
 *
 * 一格里要能一眼看出的东西：价、方向、离现价多远、**触及概率和守住概率**、被测试过几次。
 * 这两个概率是整个移植里最值钱的部分 —— 上游在 130 只训练 + 130 只互斥测试股票上验过：
 * 触及概率 AUC 0.73~0.77，区分度强；守住概率校准好（说 75% 实际 75.4%）但区分度弱（AUC 0.59~0.61），
 * 所以「守住」的绝对值可以看，别拿它比较相邻两条位。
 */
export default function LevelsStrip({ zones, manual, price, priceRound, atr }: Props) {
  const manualSet = new Set(manual.map((p) => p.toFixed(6)));
  // atr 还没算出来时（=0）不去重：阈值 0 会让「手动画的和算出来的刚好同一个价」画两遍
  const manualOnly = atr > 0
    ? manual.filter((p) => !zones.some((z) => Math.abs(z.center - p) < atr * 0.3))
    : manual;
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  // 进度条按这批位里最高的那个分归一：分数本身没有上限，直接当百分比画会溢出
  const topScore = zones.reduce((m, z) => Math.max(m, z.edge_score), 0);
  // 这条带子放不下时会横向溢出，但滚动条是藏着的 —— 光靠默认行为鼠标根本滚不动。
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [zones, manual]);

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

    // 按住拖动。卡片本身没有点击行为，所以从哪儿按都能拖
    let down = false;
    let startX = 0;
    let startLeft = 0;
    let moved = false;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || el.scrollWidth <= el.clientWidth) return;
      down = true;
      moved = false;
      startX = e.clientX;
      startLeft = el.scrollLeft;
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

  const pct = (v: number | null): string => (v === null ? '—' : Math.round(v * 100) + '%');

  return (
    <div className={`levels-strip${overflow ? ' scrollable' : ''}`} ref={stripRef}>
      <div className="lv" style={{ color: 'var(--text-2)', minWidth: 96 }}>
        <div className="r1"><span className="px" style={{ fontSize: 11 }}>ATR</span></div>
        <div className="meta"><span>{fmtPrice(atr, priceRound)}</span></div>
        <div className="meta"><span>{price > 0 ? ((atr / price) * 100).toFixed(2) + '% 波动' : '—'}</span></div>
      </div>

      {zones.length === 0 && <div className="empty" style={{ flex: 1 }}>这个周期还没识别出够格的价格带，换个周期看看</div>}

      {zones.map((z) => (
        // 这张卡上没有任何操作，就别用 button —— 能点、点下去却什么都不发生，比不给反馈更糟
        <div
          key={`${z.zone_type}-${z.center}`}
          className={`lv ${z.zone_type === 'support' ? 'sup' : 'res'}`}
          title={
            '价格带 ' + fmtPrice(z.low, priceRound) + ' - ' + fmtPrice(z.high, priceRound)
            + '（宽 ' + z.width_atr.toFixed(2) + ' ATR）'
            + ' · 历史被测试 ' + z.n_events + ' 次'
            + ' · 距离 ' + z.distance_atr.toFixed(2) + ' ATR'
            + (z.tf_count > 1 ? ' · 共振 ' + z.tf_count + ' 个周期（' + z.tfs + '）' : '')
            + (z.bucket && z.bucket_hold_rate !== null
              ? ' · 该强度档（' + z.bucket + '）在样本外实测守住率 ' + (z.bucket_hold_rate * 100).toFixed(1) + '%'
              : '')
          }
        >
          <div className="r1">
            <span className="px">{fmtPrice(z.center, priceRound)}</span>
            <span className="tag">{z.zone_type === 'support' ? '支撑' : '阻力'}</span>
          </div>
          <div className="meta">
            <span>{fmtPct(z.distance_pct, 2)}</span>
            <span title="未来若干根 K 线内，价格走到这个位的概率（模型区分度强）">
              触及 {pct(z.p_touch)}
            </span>
          </div>
          <div className="meta">
            <span title="价格走到这个位之后反弹而不是跌穿的模型概率。绝对值可信，但区分度弱，别用来比较相邻两条位">
              守住 {pct(z.p_hold)}
            </span>
            <span>{z.n_events} 次测试</span>
          </div>
          <div className="meta">
            <span>{z.width_atr.toFixed(1)} ATR 宽</span>
            {z.bucket ? (
              <span title="这条位的强度在历史分位里属于第几档（Q1 弱 → Q5 强）。是参照，不是概率">
                {z.bucket}
              </span>
            ) : null}
            {z.tf_count > 1 ? <span title={'共振周期：' + z.tfs}>共振 {z.tf_count}</span> : null}
          </div>
          <i
            className="bar"
            style={{ width: `${topScore > 0 ? (z.edge_score / topScore) * 100 : 0}%` }}
            title={'相对强度 ' + z.edge_score.toFixed(2) + '（触及次数 + 陈旧度，不是概率）'}
          />
        </div>
      ))}

      {manualOnly.length > 0 && manualOnly.map((p) => (
        <div
          key={`m-${p}`}
          className="lv"
          style={{ color: 'var(--accent)', minWidth: 104 }}
          title="你手动画的水平线"
        >
          <div className="r1">
            <span className="px">{fmtPrice(p, priceRound)}</span>
            <span className="tag">手动</span>
          </div>
          <div className="meta">
            <span>{price > 0 ? fmtPct(((p - price) / price) * 100, 2) : '—'}</span>
            <span>{manualSet.size} 条</span>
          </div>
        </div>
      ))}
    </div>
  );
}
