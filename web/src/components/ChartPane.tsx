import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { DrawingManager, defaultStyleFor, type DrawingKind } from 'lightweight-charts-drawing';
import type { Bar, Bracket, Level, Pattern, Position } from '../lib/api.ts';

const UP = '#2ed3a0';
const DOWN = '#ff5f6d';
const NEUTRAL = '#8b98a5';
/** 计划入场：虚线，和跟着价格跑的最新价线区分开 */
const ENTRY = '#7aa2ff';
/** 真实持仓成本 */
const HOLDING = '#ffcf4d';

/**
 * 把形态转成图上的标记。
 * 只标记当前这份数据里真实存在的时间点 —— 切币种那一瞬间旧形态可能还没清掉，
 * 给不存在的 K 线挂标记没有任何意义。
 */
function buildMarkers(list: Pattern[], bars: Bar[]): SeriesMarker<Time>[] {
  const times = new Set(bars.map((b) => b.time));
  return [...list]
    .filter((p) => times.has(p.time))
    .sort((a, b) => a.time - b.time)
    .map((p) => ({
      time: p.time as Time,
      position: p.direction === 'bullish' ? 'belowBar' : 'aboveBar',
      color: p.direction === 'bullish' ? UP : p.direction === 'bearish' ? DOWN : NEUTRAL,
      shape: p.direction === 'bullish' ? 'arrowUp' : p.direction === 'bearish' ? 'arrowDown' : 'circle',
      text: p.name,
    }));
}

/**
 * 把 K 线整理成 lightweight-charts 能接受的形状：时间严格递增，重复时间只留最后一根。
 * setData 和 update 都要求时间有序，乱序会直接抛异常。
 */
function normalize(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of [...bars].sort((x, y) => x.time - y.time)) {
    const prev = out[out.length - 1];
    if (prev && prev.time === b.time) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}

const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;

const TOOLS: { kind: DrawingKind; label: string; title: string }[] = [
  { kind: 'horizontal-line', label: '水平线', title: '水平价位线（拖拽即改价）' },
  { kind: 'trend-line', label: '趋势线', title: '两点连线' },
  { kind: 'ray', label: '射线', title: '向右延伸' },
  { kind: 'parallel-channel', label: '通道', title: '平行通道' },
  { kind: 'rectangle', label: '矩形', title: '矩形区间' },
  { kind: 'fib-retracement', label: '斐波', title: '斐波那契回撤' },
  { kind: 'long-position', label: '做多仓位', title: '多头风险/收益盒' },
  { kind: 'short-position', label: '做空仓位', title: '空头风险/收益盒' },
  { kind: 'text', label: '文字', title: '文字标注' },
];

interface Props {
  contract: string;
  interval: string;
  bars: Bar[];
  levels: Level[];
  patterns: Pattern[];
  bracket: Bracket | null;
  /** 当前合约的真实持仓，用来在图上标出成本线（双向模式可能多空各一条） */
  positions: Position[];
  resetKey: string;
  loading: boolean;
  /** 拖到最左边时向上再要一页更早的 K 线 */
  onNeedOlder?: () => void;
  onIntervalChange: (i: string) => void;
  onManualLevels: (prices: number[]) => void;
}

export default function ChartPane({
  contract, interval, bars, levels, patterns, bracket, positions, resetKey, loading, onNeedOlder, onIntervalChange, onManualLevels,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const dmRef = useRef<DrawingManager | null>(null);
  const levelLinesRef = useRef<IPriceLine[]>([]);
  const bracketLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const patternsRef = useRef<Pattern[]>(patterns);
  const barsRef = useRef<Bar[]>(bars);
  const lastKeyRef = useRef<string>('');
  /** 图上最后一根 K 线的时间。update() 不接受比它更早的时间，必须自己挡。 */
  const lastTimeRef = useRef<number | null>(null);
  /** 图上最左边那根的时间和总根数，用来识别「往前补了一段历史」 */
  const firstTimeRef = useRef<number | null>(null);
  const countRef = useRef(0);
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const [legend, setLegend] = useState<{ o: number; h: number; l: number; c: number; v: number; t: number } | null>(null);

  const storageKey = `xf-rine:drawings:${contract}:${interval}`;
  barsRef.current = bars;
  patternsRef.current = patterns;

  // ---- 建图 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0c0e12' },
        textColor: '#98a2b3',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(30,35,44,0.55)' },
        horzLines: { color: 'rgba(30,35,44,0.55)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(152,162,179,0.4)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#1e232d' },
        horzLine: { color: 'rgba(152,162,179,0.4)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#1e232d' },
      },
      rightPriceScale: {
        borderColor: '#1e232c',
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: '#1e232c',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 8,
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (p: number) => (p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(3) : p.toFixed(6)),
      },
    });

    const price = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: true,
      priceLineColor: '#4c8dff',
      priceLineStyle: LineStyle.Dotted,
      lastValueVisible: true,
    });

    // 形态标记：切币种会重建整张图，所以建图时用 ref 里的最新形态补一次
    markersRef.current = createSeriesMarkers(price, buildMarkers(patternsRef.current, barsRef.current));

    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('vol').applyOptions({ visible: false, scaleMargins: { top: 0.84, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) { setLegend(null); return; }
      const d = param.seriesData.get(price) as { open: number; high: number; low: number; close: number } | undefined;
      const v = param.seriesData.get(vol) as { value: number } | undefined;
      if (!d) { setLegend(null); return; }
      setLegend({ o: d.open, h: d.high, l: d.low, c: d.close, v: v?.value ?? 0, t: Number(param.time) });
    });

    const dm = new DrawingManager(chart, price, {
      magnet: 'weak',
      dragToPlace: false,
      clampToPane: true,
      bars: () => barsRef.current.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume,
      })),
      timeInfo: () => ({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, intraday: true }),
    });

    let saveTimer: number | undefined;
    const collect = () => {
      const prices: number[] = [];
      for (const d of dm.drawings()) {
        if (d.kind === 'horizontal-line' && d.points[0]) prices.push(d.points[0].price);
      }
      onManualLevels(prices);
    };
    const persist = () => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        try { localStorage.setItem(storageKey, dm.exportJSON()); } catch { /* 配额满了就算了 */ }
        collect();
      }, 250);
    };
    const unsubs = [
      dm.on('add', persist),
      dm.on('remove', persist),
      dm.on('gestureEnd', persist),
      dm.on('tool', (k) => setTool(k as DrawingKind | null)),
    ];

    chartRef.current = chart;
    priceRef.current = price;
    volRef.current = vol;
    dmRef.current = dm;

    return () => {
      for (const u of unsubs) u();
      window.clearTimeout(saveTimer);
      dm.destroy();
      chart.remove();
      chartRef.current = null;
      priceRef.current = null;
      volRef.current = null;
      dmRef.current = null;
      markersRef.current = null;
      levelLinesRef.current = [];
      bracketLinesRef.current = [];
      lastTimeRef.current = null;
    };
    // onManualLevels 有意不放进依赖：它是每次渲染新建的箭头函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // ---- 形态标记 ----
  const patternSig = patterns.map((p) => `${p.kind}@${p.time}`).join('|');
  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    try {
      plugin.setMarkers(buildMarkers(patternsRef.current, barsRef.current));
    } catch (err) {
      // 标记画不出来不影响看盘，别让它把整个界面带下去
      console.warn('[chart] 写入形态标记失败', err);
    }
    // 只在形态本身变了时重画，K 线每来一根都重算没意义
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patternSig, storageKey]);

  // ---- K 线数据 ----
  useEffect(() => {
    const chart = chartRef.current;
    const price = priceRef.current;
    const vol = volRef.current;
    const dm = dmRef.current;
    if (!chart || !price || !vol || !dm) return;
    if (bars.length === 0) return;

    const writePrice = (b: Bar) => price.update({
      time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
    });
    const writeVol = (b: Bar) => vol.update({
      time: b.time as UTCTimestamp,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(46,211,160,0.28)' : 'rgba(255,95,109,0.28)',
    });
    const fullLoad = () => {
      const clean = normalize(bars);
      price.setData(clean.map((b) => ({
        time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
      })));
      vol.setData(clean.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(46,211,160,0.28)' : 'rgba(255,95,109,0.28)',
      })));
      lastTimeRef.current = clean[clean.length - 1]?.time ?? null;
      firstTimeRef.current = clean[0]?.time ?? null;
      countRef.current = clean.length;
      // 500 根全展开会把价格压成一条线，日内用不上。默认只看最近 160 根。
      const from = Math.max(0, clean.length - 160);
      chart.timeScale().setVisibleLogicalRange({ from, to: clean.length + 6 });
    };

    try {
      // 往前补了历史。整段 setData 就够了，视口不用管（见下面）
      const cleanBars = normalize(bars);
      const prevFirst = firstTimeRef.current;
      const prevCount = countRef.current;
      if (
        lastKeyRef.current === resetKey
        && prevFirst != null
        && cleanBars.length > prevCount
        && cleanBars[0]!.time < prevFirst
      ) {
        price.setData(cleanBars.map((b) => ({
          time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
        })));
        vol.setData(cleanBars.map((b) => ({
          time: b.time as UTCTimestamp,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(46,211,160,0.28)' : 'rgba(255,95,109,0.28)',
        })));
        lastTimeRef.current = cleanBars[cleanBars.length - 1]?.time ?? null;
        firstTimeRef.current = cleanBars[0]?.time ?? null;
        countRef.current = cleanBars.length;
        // 这里故意不平移视口。lightweight-charts 的 setData 是按时间对齐的：
        // 前面插入 500 根之后，它自己就把视口挪到了同样那些 K 线上。
        // 再按「补进来的根数」平移一次会多跳 500 根，直接飞到数据外面去。
        return;
      }

      const firstLoad = lastKeyRef.current !== resetKey;
      if (firstLoad) {
        lastKeyRef.current = resetKey;
        lastTimeRef.current = null;
        fullLoad();
        try {
          const saved = localStorage.getItem(storageKey);
          if (saved) dm.importJSON(saved);
        } catch { /* 数据坏了就当没有 */ }
        return;
      }

      // 拿到的是一份比图上更旧的快照（REST 有缓存，可能落后于 WebSocket 推来的那根），
      // 增量写不进去，整段重设。
      const newest = bars[bars.length - 1]!;
      const applied = lastTimeRef.current;
      if (applied != null && newest.time < applied) {
        fullLoad();
        return;
      }

      // 增量：只刷新最后两根。update() 只接受「不比图上最后一根更早」的时间，
      // 早于它就会抛 Cannot update oldest data —— 这个异常会把整个 React 树卸掉。
      for (const b of bars.slice(-2)) {
        if (applied != null && b.time < applied) continue;
        writePrice(b);
        writeVol(b);
        lastTimeRef.current = b.time;
      }
    } catch (err) {
      // 任何写图表的异常都不能冒泡到 React，否则整页变黑
      console.warn('[chart] 写入 K 线失败，改为整段重设', err);
      try { fullLoad(); } catch { /* 实在不行就保持现状 */ }
    }
  }, [bars, resetKey, storageKey]);

  // ---- 往回拖到底时，向上要一页更早的 K 线 ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onNeedOlder) return;
    const ts = chart.timeScale();
    const handler = () => {
      // 图还没画上这一份数据时（挂载瞬间、刚切币种），range 会是 {0,0} 之类，
      // 那不是用户拖到了最左，别把它当成要历史。
      if (countRef.current === 0 || lastKeyRef.current !== resetKey) return;
      const r = ts.getVisibleLogicalRange();
      if (!r) return;
      // from < 6 意味着最左边那几根已经贴到边缘了，该补了
      if (r.from < 6) onNeedOlder();
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => ts.unsubscribeVisibleLogicalRangeChange(handler);
  }, [onNeedOlder, resetKey]);

  // ---- 自动识别出的支撑 / 阻力 ----
  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;

    for (const line of levelLinesRef.current) price.removePriceLine(line);
    for (const line of bracketLinesRef.current) price.removePriceLine(line);
    levelLinesRef.current = [];
    bracketLinesRef.current = [];

    // 线可以多，字不能挤。每条线都留着，但右侧轴标签和标题按优先级抢位子：
    // 同一段价位上只让一条说话，剩下的只画线不写字。
    const all = barsRef.current;
    const last = all[all.length - 1]?.close ?? 0;
    // 阈值必须按「当前看得见的那一段」算，不能按固定根数：
    // 缩放到只看几十根时价格跨度小，按固定根数算出来的间距会把标签全放过。
    const chart = chartRef.current;
    const vis = chart?.timeScale().getVisibleLogicalRange();
    const from = vis ? Math.max(0, Math.floor(vis.from)) : Math.max(0, all.length - 180);
    const to = vis ? Math.min(all.length - 1, Math.ceil(vis.to)) : all.length - 1;
    const win = all.slice(from, to + 1);
    let hi = -Infinity;
    let lo = Infinity;
    for (const b of win) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
    const span = Number.isFinite(hi) && Number.isFinite(lo) ? hi - lo : 0;
    // 3.5% 的可视价格跨度，换算成像素大约是一个轴标签的高度
    const minGap = span > 0 ? span * 0.035 : 0;
    const slots: number[] = [];

    interface Item {
      price: number;
      /** 越小越先占位 */
      rank: number;
      color: string;
      width: 1 | 2;
      style: LineStyle;
      title: string;
      /** 想不想显示标签 */
      wants: boolean;
    }

    const items: Item[] = [];

    if (bracket) {
      // 计划入场不是现价线：现价线跟着价格跑，价格一走开就看不出原本打算在哪进了
      items.push(
        { price: bracket.stop, rank: 0, color: DOWN, width: 2, style: LineStyle.Solid, title: '止损', wants: true },
        { price: bracket.target, rank: 0, color: UP, width: 2, style: LineStyle.Solid, title: '止盈', wants: true },
        { price: bracket.entry, rank: 2, color: ENTRY, width: 1, style: LineStyle.Dashed, title: '入场', wants: true },
      );
    }

    for (const p of positions) {
      if (!p.entryPrice || !p.size) continue;
      items.push({
        price: p.entryPrice,
        rank: 1,
        color: HOLDING,
        width: 2,
        style: LineStyle.Solid,
        title: positions.length > 1 ? (p.direction === 'long' ? '多单均价' : '空单均价') : '持仓均价',
        wants: true,
      });
    }

    // 档位按离现价远近排，近的先说话
    const byNear = [...levels].sort((a, b) => Math.abs(a.price - last) - Math.abs(b.price - last));
    byNear.forEach((lv, i) => {
      const strong = lv.strength >= 55;
      items.push({
        price: lv.price,
        rank: 3 + i * 0.01,
        color: lv.role === 'support' ? 'rgba(46,211,160,0.55)' : 'rgba(255,95,109,0.55)',
        width: 1,
        style: strong ? LineStyle.Solid : LineStyle.Dashed,
        title: `${lv.role === 'support' ? '支撑' : '阻力'} ${Math.round(lv.strength)}`,
        // 强度不够的档位本来就不该喊，只留一条虚线
        wants: strong,
      });
    });

    items.sort((a, b) => a.rank - b.rank);

    const board: IPriceLine[] = [];
    for (const it of items) {
      let label = false;
      if (it.wants) {
        const crowded = minGap > 0 && slots.some((q) => Math.abs(q - it.price) < minGap);
        if (!crowded) {
          label = true;
          slots.push(it.price);
        }
      }
      const line = price.createPriceLine({
        price: it.price,
        color: it.color,
        lineWidth: it.width,
        lineStyle: it.style,
        axisLabelVisible: label,
        title: label ? it.title : '',
      });
      board.push(line);
    }

    // 分两个 ref 只是为了记录要清理的线，这里一起收
    levelLinesRef.current = [];
    bracketLinesRef.current = board;
  }, [levels, bracket, positions]);

  // ---- 工具切换 ----
  useEffect(() => {
    dmRef.current?.setTool(tool);
  }, [tool]);

  return (
    <>
      <div className="chart-tools">
        <div className="seg">
          {INTERVALS.map((i) => (
            <button key={i} className={i === interval ? 'on' : ''} onClick={() => onIntervalChange(i)}>{i}</button>
          ))}
        </div>
        <div className="tool-divider" />
        {TOOLS.map((t) => (
          <button
            key={t.kind}
            title={t.title}
            className={`tool-btn ${tool === t.kind ? 'on' : ''}`}
            onClick={() => setTool(tool === t.kind ? null : t.kind)}
          >
            {t.label}
          </button>
        ))}
        <div className="tool-divider" />
        <button
          className="icon-btn"
          title="删除选中的画线（先点线选中，再按 Delete）"
          onClick={() => {
            const dm = dmRef.current;
            if (!dm) return;
            for (const id of dm.selection()) dm.remove(id);
          }}
        >
          ⌫
        </button>
        <button
          className="icon-btn"
          title="清空本图所有画线"
          onClick={() => {
            const dm = dmRef.current;
            if (!dm) return;
            if (!window.confirm('清空这张图上所有手动画线？')) return;
            dm.clear();
            try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
            onManualLevels([]);
          }}
        >
          ⌦
        </button>
        <div className="spacer" style={{ flex: 1 }} />
        <span className="dim" style={{ fontSize: 10.5 }}>画线自动存本地</span>
      </div>

      <div className="chart-wrap">
        <div className="chart-host" ref={hostRef} />
        {legend && (
          <div className="chart-badge">
            <span>O {legend.o}</span>
            <span className="up">H {legend.h}</span>
            <span className="down">L {legend.l}</span>
            <span>C {legend.c}</span>
            <span>V {Math.round(legend.v)}</span>
          </div>
        )}
        {loading && <div className="loading">加载中…</div>}
      </div>
    </>
  );
}

/** 给工具按钮的默认样式兜底：某些 kind 的默认色是蓝色，改成不那么扎眼的灰蓝 */
export function tint(kind: DrawingKind): string {
  return defaultStyleFor(kind).color ?? '#4c8dff';
}
