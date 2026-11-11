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
  // atr 还没算出来时（=0）不去重：阈值 0 会让「手动画的和算出来的刚好同一个价」画两遍
  const manualOnly = atr > 0
    ? manual.filter((p) => !levels.some((l) => Math.abs(l.price - p) < atr * 0.3))
    : manual;
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  // 进度条按这批位里最高的那个分归一：分数本身没有上限，直接当百分比画会溢出
  const topScore = levels.reduce((m, l) => Math.max(m, l.score), 0);
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
        <div className="meta"><span>{price > 0 ? ((atr / price) * 100).toFixed(2) + '% 波动' : '—'}</span></div>
      </div>

      {levels.length === 0 && <div className="empty" style={{ flex: 1 }}>这个周期还没识别出够格的价格带，换个周期看看</div>}

      {levels.map((lv) => (
        // 这张卡上没有任何操作，就别用 button —— 能点、点下去却什么都不发生，比不给反馈更糟
        <div
          key={`${lv.role}-${lv.price}`}
          className={`lv ${lv.role === 'support' ? 'sup' : 'res'}`}
          title={
            '价格带 ' + fmtPrice(lv.zoneLow, priceRound) + ' - ' + fmtPrice(lv.zoneHigh, priceRound)
            + '（宽 ' + lv.widthAtr.toFixed(2) + ' ATR）'
            + ' · 历史触及 ' + lv.touches + ' 次，守住 ' + lv.holds + ' 次'
            + ' · 距离 ' + lv.distAtr.toFixed(2) + ' ATR'
            + (lv.barsSinceTouch >= 0 ? ' · 最近一次在 ' + lv.barsSinceTouch + ' 根前' : ' · 这段里没碰到过')
          }
        >
          <div className="r1">
            <span className="px">{fmtPrice(lv.price, priceRound)}</span>
            <span className="tag">{lv.role === 'support' ? '支撑' : '阻力'}</span>
          </div>
          <div className="meta">
            <span>{fmtPct(lv.distancePct, 2)}</span>
            <span title="历史上触及这个价格带之后守住的比例，样本少时给的是保守下界">
              守住 {Math.round(lv.holdRate * 100)}%
            </span>
          </div>
          <div className="meta">
            <span>{lv.touches} 次触及</span>
            <span>{lv.widthAtr.toFixed(1)} ATR 宽</span>
          </div>
          {lv.bucket ? (
            // 上游在 A 股日线上标定的分档线：说明「这个分数在那一批样本里属于高档还是低档」。
            // 措辞必须是「第几档」，不能写成胜率 —— 那份样本和加密盘口不是一个东西
            <div className="meta">
              <span title="排序分落在上游 A 股日线标定分位的第几档（1 低 5 高）。是参照，不是概率，也不是这里的胜率">
                历史分位 Q{lv.bucket}
              </span>
            </div>
          ) : null}
          <i
            className="bar"
            style={{ width: `${topScore > 0 ? (lv.score / topScore) * 100 : 0}%` }}
            title={'相对分数 ' + lv.score.toFixed(2) + '（触及次数 + 陈旧度，不是概率）'}
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
