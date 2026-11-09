import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { DrawingManager, defaultStyleFor, type DrawingKind } from 'lightweight-charts-drawing';
import type { Bar, Bracket, Level } from '../lib/api.ts';

const UP = '#2ed3a0';
const DOWN = '#ff5f6d';

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
  bracket: Bracket | null;
  resetKey: string;
  loading: boolean;
  onIntervalChange: (i: string) => void;
  onManualLevels: (prices: number[]) => void;
}

export default function ChartPane({
  contract, interval, bars, levels, bracket, resetKey, loading, onIntervalChange, onManualLevels,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const dmRef = useRef<DrawingManager | null>(null);
  const levelLinesRef = useRef<IPriceLine[]>([]);
  const bracketLinesRef = useRef<IPriceLine[]>([]);
  const barsRef = useRef<Bar[]>(bars);
  const lastKeyRef = useRef<string>('');
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const [legend, setLegend] = useState<{ o: number; h: number; l: number; c: number; v: number; t: number } | null>(null);

  const storageKey = `xf-rine:drawings:${contract}:${interval}`;
  barsRef.current = bars;

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
      levelLinesRef.current = [];
      bracketLinesRef.current = [];
    };
    // onManualLevels 有意不放进依赖：它是每次渲染新建的箭头函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // ---- K 线数据 ----
  useEffect(() => {
    const chart = chartRef.current;
    const price = priceRef.current;
    const vol = volRef.current;
    const dm = dmRef.current;
    if (!chart || !price || !vol || !dm) return;
    if (bars.length === 0) return;

    const firstLoad = lastKeyRef.current !== resetKey;
    if (firstLoad) {
      lastKeyRef.current = resetKey;
      price.setData(bars.map((b) => ({
        time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
      })));
      vol.setData(bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(46,211,160,0.28)' : 'rgba(255,95,109,0.28)',
      })));
      // 500 根全展开会把价格压成一条线，日内用不上。默认只看最近 160 根。
      const from = Math.max(0, bars.length - 160);
      chart.timeScale().setVisibleLogicalRange({ from, to: bars.length + 6 });
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) dm.importJSON(saved);
      } catch { /* 数据坏了就当没有 */ }
      return;
    }

    // 增量：只刷新最后两根（当前未走完的一根 + 刚收掉的一根）
    const tail = bars.slice(-2);
    for (const b of tail) {
      price.update({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
      vol.update({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(46,211,160,0.28)' : 'rgba(255,95,109,0.28)',
      });
    }
  }, [bars, resetKey, storageKey]);

  // ---- 自动识别出的支撑 / 阻力 ----
  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;

    for (const line of levelLinesRef.current) price.removePriceLine(line);
    for (const line of bracketLinesRef.current) price.removePriceLine(line);
    levelLinesRef.current = [];
    bracketLinesRef.current = [];

    // 止盈价本身就是那条阻力位，两条线画在同一价格上只会把右侧轴标签叠在一起
    const taken = bracket ? [bracket.stop, bracket.target] : [];
    const clashes = (a: number, b: number) => Math.abs(a - b) / (b || 1) < 0.0006;

    levelLinesRef.current = levels
      .filter((lv) => !taken.some((p) => clashes(lv.price, p)))
      .map((lv) => price.createPriceLine({
        price: lv.price,
        color: lv.role === 'support' ? 'rgba(46,211,160,0.55)' : 'rgba(255,95,109,0.55)',
        lineWidth: 1,
        lineStyle: lv.strength >= 55 ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${lv.role === 'support' ? 'S' : 'R'}${Math.round(lv.strength)}`,
      }));

    if (!bracket) return;
    // 入场价就是现价，图上已经有一条原生最新价线，再画一条只是把轴标签叠乱
    bracketLinesRef.current = [
      price.createPriceLine({
        price: bracket.stop, color: DOWN, lineWidth: 2, lineStyle: LineStyle.Solid,
        axisLabelVisible: true, title: 'SL',
      }),
      price.createPriceLine({
        price: bracket.target, color: UP, lineWidth: 2, lineStyle: LineStyle.Solid,
        axisLabelVisible: true, title: 'TP',
      }),
    ];
  }, [levels, bracket]);

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
