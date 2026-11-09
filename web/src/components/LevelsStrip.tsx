import { useEffect, useRef, useState } from 'react';
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
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  // 这条带子放不下时会横向溢出，但滚动条是藏着的 —— 光靠默认行为鼠标根本滚不动。
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [levels, manual]);

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

  return (
    <div className={`levels-strip${overflow ? ' scrollable' : ''}`} ref={stripRef}>
      <div className="lv" style={{ color: 'var(--text-2)', minWidth: 96 }}>
        <div className="r1"><span className="px" style={{ fontSize: 11 }}>ATR</span></div>
        <div className="meta"><span>{fmtPrice(atr, priceRound)}</span></div>
        <div className="meta"><span>{(atr / (price || 1) * 100).toFixed(2)}% 波动</span></div>
      </div>

      {levels.length === 0 && <div className="empty" style={{ flex: 1 }}>这个周期还没有识别出够强的位，换个周期或调低最小强度</div>}

      {levels.map((lv) => (
        // 这张卡上没有任何操作，就别用 button —— 能点、点下去却什么都不发生，比不给反馈更糟
        <div
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
        </div>
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
