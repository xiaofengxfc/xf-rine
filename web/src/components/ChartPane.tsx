import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type AutoscaleInfoProvider,
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
import type { Bar, Bracket, Level, OpenOrder, Pattern, Position, PriceOrder } from '../lib/api.ts';
import { firstIndexAtOrAfter, normalizeBars, paintBars, sparseStats, type PaintedBar } from '../lib/candles.ts';
import { pendingOrderLines } from '../lib/orderLines.ts';
import { pnlOf } from '../lib/position.ts';
import { bracketOf } from '../lib/protective.ts';
import { fmtDate, fmtMoney, fmtPct, fmtPrice } from '../lib/format.ts';

const UP = '#2ed3a0';
const DOWN = '#ff5f6d';
const NEUTRAL = '#8b98a5';
/** 计划入场：虚线，和跟着价格跑的最新价线区分开 */
const ENTRY = '#7aa2ff';
/** 真实持仓成本 */
const HOLDING = '#ffcf4d';
/** 还挂着的限价单 */
const PENDING = '#b58bff';
/**
 * 平价 K 线（那段时间没人成交）用中性灰。
 * 开收相同的线用绿或红都是在替交易所编行情。
 */
const FLAT = 'rgba(139,152,165,0.55)';
/** 视口里平价占比超过这个数，就要说一句「这币成交稀疏」 */
const SPARSE_SHARE = 0.6;
/** 太少不看：刚开局几十根说明不了什么 */
const SPARSE_MIN_BARS = 40;
/** 画法的偏好记在本地：自动 / 只用 K 线 / 只用折线 */
const MODE_KEY = 'xf-rine:chart:mode';
type ChartMode = 'auto' | 'candle' | 'line';
function readMode(): ChartMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'candle' || v === 'line' ? v : 'auto';
  } catch { return 'auto'; }
}

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
 * 视口左边少于这么多根就催一次历史。
 *
 * 只是催，不是停手的条件：App 那边会把能拿的一路补到底。
 */
const PREFETCH_BARS = 3000;

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
  /** 当前合约还挂着的委托，限价单在图上画一条线，成交或撤掉就消失 */
  orders: OpenOrder[];
  /** 当前合约真实挂着的止损止盈。这是交易所里的单，不是算出来的方案价 */
  priceOrders: PriceOrder[];
  /** 每张多少币。把价格差换算成 USDT 只有它能做 */
  multiplier: number;
  /** 实时标记价：交易所按它算已盈亏，图上的盈亏也按它算 */
  markPrice: number;
  /** 这个合约的最小变动价，图上叠加层的价格按它写 */
  priceRound: number;
  /** 私有数据停更时的信息。图上那几条持仓线是旧快照，得说出来 */
  stale?: { err: string; ageMs: number } | null;
  resetKey: string;
  loading: boolean;
  /** 视口左边快没 K 线了，要补。带上当前左边界（逻辑序号），App 据此决定补几页 */
  onNeedOlder?: (from: number) => void;
  /** 交易所能给的历史到头了。图上要说一声，不然拖到头看着像卡死 */
  historyEnd?: boolean;
  /** 后台正在往左补历史 */
  backfilling?: boolean;
  onIntervalChange: (i: string) => void;
  onManualLevels: (prices: number[]) => void;
}

export default function ChartPane({
  contract, interval, bars, levels, patterns, bracket, positions, orders, priceOrders, multiplier, markPrice, priceRound,
  stale, resetKey, loading, onNeedOlder, historyEnd, backfilling, onIntervalChange, onManualLevels,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  /** 收盘价折线：成交稀疏的合约用这条，比一排小方块看着清楚 */
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const dmRef = useRef<DrawingManager | null>(null);
  const levelLinesRef = useRef<IPriceLine[]>([]);
  const bracketLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  /** 折线模式下形态标记挂在折线上：同一个数组，曲线上一模一样的位置 */
  const lineMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const patternsRef = useRef<Pattern[]>(patterns);
  const barsRef = useRef<Bar[]>(bars);
  /** 补历史这件事要在 K 线落地之后再催一次，用 ref 拿最新的回调 */
  const needOlderRef = useRef(onNeedOlder);
  needOlderRef.current = onNeedOlder;
  /** 这一帧已经排了一次「把视口拉回数据边缘」，别排队排成一串 */
  const clampingRef = useRef(false);
  const lastKeyRef = useRef<string>('');
  /** 图上最后一根 K 线的时间。update() 不接受比它更早的时间，必须自己挡。 */
  const lastTimeRef = useRef<number | null>(null);
  /** 图上最左边那根的时间和总根数，用来识别「往前补了一段历史」 */
  const firstTimeRef = useRef<number | null>(null);
  const countRef = useRef(0);
  /** 画图用的那版 K 线（平价线已撑开）。同一份数据只算一次，别每秒拷两万根 */
  const paintRef = useRef<{ src: Bar[] | null; tick: number; out: PaintedBar[] }>({ src: null, tick: -1, out: [] });
  /** 可视区里有多少根画不出实体。冷门币必须说一句，不然看着像图上缺了一块 */
  const [sparse, setSparse] = useState<{ count: number; flat: number } | null>(null);

  /**
   * 数一下视口里有多少根平价 K 线。
   *
   * 冷门币这个比例能到 100%，图上一整片都是灰线 —— 不说明的话就是一种「K 线残缺」。
   * 按可视范围算：缩放到确实有成交的那一段，提示自己就没了。
   */
  const refreshSparse = useCallback(() => {
    const chart = chartRef.current;
    const all = barsRef.current;
    if (!chart || all.length === 0) { setSparse(null); return; }
    const r = chart.timeScale().getVisibleLogicalRange();
    const from = r ? Math.max(0, Math.floor(r.from)) : Math.max(0, all.length - 180);
    const to = r ? Math.min(all.length - 1, Math.ceil(r.to)) : all.length - 1;
    if (to < from) { setSparse(null); return; }
    const s = sparseStats(all.slice(from, to + 1));
    setSparse(s.count >= SPARSE_MIN_BARS ? { count: s.count, flat: s.flat } : null);
  }, []);

  /** 画法偏好。默认自动：视口里平价线过半就改画折线 */
  const [mode, setMode] = useState<ChartMode>(readMode);
  const flatShare = sparse ? sparse.flat / Math.max(1, sparse.count) : 0;
  const drawMode: 'candle' | 'line' = mode === 'auto'
    ? (sparse !== null && flatShare >= SPARSE_SHARE ? 'line' : 'candle')
    : mode;

  useEffect(() => {
    priceRef.current?.applyOptions({ visible: drawMode === 'candle' });
    lineRef.current?.applyOptions({ visible: drawMode === 'line' });
  }, [drawMode]);

  const pickMode = useCallback((next: ChartMode) => {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* 存不了就算了 */ }
  }, []);
  const [tool, setTool] = useState<DrawingKind | null>(null);
  /** 视口已经贴到最左边那根了。到头说明只在贴边时才显示，不然一开页面就挂在图上 */
  const [atEdge, setAtEdge] = useState(false);
  const [legend, setLegend] = useState<{ o: number | null; h: number | null; l: number | null; c: number; v: number; t: number } | null>(null);

  const storageKey = `xf-rine:drawings:${contract}:${interval}`;
  // 视口也按币种和周期各记一份，刷新后接着看同一段
  const viewKey = `xf-rine:view:${contract}:${interval}`;
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

    /**
     * 收盘价折线：给成交稀疏的合约用。
     *
     * 平价 K 线就算撑开了也只是一排小方块，一大段看着还是「连不上」。
     * 折线把收盘价连起来，价格的台阶一眼能看出来 —— 它不假装有成交量，只是换一种画法。
     */
    const line = chart.addSeries(LineSeries, {
      color: '#9aa7b8',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 3,
      visible: false,
    });

    // 形态标记：切币种会重建整张图，所以建图时用 ref 里的最新形态补一次
    markersRef.current = createSeriesMarkers(price, buildMarkers(patternsRef.current, barsRef.current));
    lineMarkersRef.current = createSeriesMarkers(line, []);

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
      const frame = param.seriesData.get(line) as { value: number } | undefined;
      const v = param.seriesData.get(vol) as { value: number } | undefined;
      // 折线模式下没有开高低，只剩收盘价：图上别显示一排「undefined」
      if (!d && !frame) { setLegend(null); return; }
      setLegend({
        o: d ? d.open : null,
        h: d ? d.high : null,
        l: d ? d.low : null,
        c: d ? d.close : frame!.value,
        v: v?.value ?? 0,
        t: Number(param.time),
      });
    });

    /**
     * 画线工具的吸附要拿 K 线做时间定位，鼠标每动一下它就会问一遍。
     * 一万多根的话，每问一次就 map 一遍，拖着能明显发涩 —— 缓存一份，数据换了才重算。
     */
    let snapSrc: Bar[] | null = null;
    let snapOut: { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number }[] = [];
    const snapBars = () => {
      if (snapSrc !== barsRef.current) {
        snapSrc = barsRef.current;
        snapOut = snapSrc.map((b) => ({
          time: b.time as UTCTimestamp,
          open: b.open, high: b.high, low: b.low, close: b.close,
          volume: b.volume,
        }));
      }
      return snapOut;
    };

    const dm = new DrawingManager(chart, price, {
      magnet: 'weak',
      dragToPlace: false,
      clampToPane: true,
      bars: snapBars,
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
    lineRef.current = line;
    volRef.current = vol;
    dmRef.current = dm;

    return () => {
      for (const u of unsubs) u();
      window.clearTimeout(saveTimer);
      dm.destroy();
      chart.remove();
      chartRef.current = null;
      priceRef.current = null;
      lineRef.current = null;
      volRef.current = null;
      dmRef.current = null;
      markersRef.current = null;
      lineMarkersRef.current = null;
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
      // 标记跟着当前画法走：折线模式下挂在 K 线序列上是看不见的
      const list = buildMarkers(patternsRef.current, barsRef.current);
      if (drawMode === 'line') {
        lineMarkersRef.current?.setMarkers(list);
        plugin.setMarkers([]);
      } else {
        plugin.setMarkers(list);
        lineMarkersRef.current?.setMarkers([]);
      }
    } catch (err) {
      // 标记画不出来不影响看盘，别让它把整个界面带下去
      console.warn('[chart] 写入形态标记失败', err);
    }
    // 只在形态本身变了时重画，K 线每来一根都重算没意义
    // 画法是依赖：切到折线要把标记搬过去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patternSig, storageKey, drawMode]);

  // ---- K 线数据 ----
  useEffect(() => {
    const chart = chartRef.current;
    const price = priceRef.current;
    const vol = volRef.current;
    const dm = dmRef.current;
    const line = lineRef.current;
    if (!chart || !price || !vol || !line || !dm) return;
    if (bars.length === 0) return;

    /**
     * 画之前过一遍 paintBars：平价 K 线（没成交的那些分钟）撑开一个最小变动价。
     *
     * 不撑的话图上是一排断续的小方块，冷门币看着就是「K 线连不上、残了一块」。
     * 撑开的只是影线，开收量一个数都不动，而且只喂给图 ——
     * 形态、档位、盈亏用的仍是原始数据。
     */
    const painted = (): PaintedBar[] => {
      const cache = paintRef.current;
      if (cache.src === bars && cache.tick === priceRound) return cache.out;
      const out = paintBars(normalizeBars(bars), priceRound);
      paintRef.current = { src: bars, tick: priceRound, out };
      return out;
    };
    /** 平价线给中性灰：它没有涨跌，涂成绿或红都是在编行情 */
    const point = (b: PaintedBar) => (b.flat
      ? {
        time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
        color: FLAT, borderColor: FLAT, wickColor: FLAT,
      }
      : { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
    const writePrice = (b: PaintedBar) => price.update(point(b));
    /** 折线只用收盘价：稀疏合约看着就是价格的台阶，比一排小方块清楚 */
    const writeLine = (b: PaintedBar) => line.update({ time: b.time as UTCTimestamp, value: b.close });
    const lineData = (list: PaintedBar[]) => list.map((b) => ({ time: b.time as UTCTimestamp, value: b.close }));
    const writeVol = (b: Bar) => vol.update({
      time: b.time as UTCTimestamp,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(46,211,160,0.28)' : 'rgba(255,95,109,0.28)',
    });
    const fullLoad = () => {
      const clean = painted();
      price.setData(clean.map(point));
      line.setData(lineData(clean));
      vol.setData(clean.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(46,211,160,0.28)' : 'rgba(255,95,109,0.28)',
      })));
      lastTimeRef.current = clean[clean.length - 1]?.time ?? null;
      firstTimeRef.current = clean[0]?.time ?? null;
      countRef.current = clean.length;
      /**
       * 优先恢复上次看到的那一段，记的是**时间**不是下标。
       *
       * 记下标是错的：这次拉到的根数（首屏 1000 根 / 往回补完 8000 根）和上次不一样，
       * 同一个下标指向的是完全不同的时间 —— 于是打开页面看到的是三个月前的行情，
       * 而顶上的现价是今天的，看着就是「K 线不对」。时间在哪个文件里都一样。
       */
      let restored = false;
      try {
        const saved = JSON.parse(localStorage.getItem(viewKey) ?? 'null') as { fromTime?: number; toTime?: number } | null;
        if (saved && Number.isFinite(saved.fromTime) && Number.isFinite(saved.toTime)) {
          const a = firstIndexAtOrAfter(clean, saved.fromTime as number);
          const b = firstIndexAtOrAfter(clean, saved.toTime as number);
          if (b - a >= 8) {
            // 右边留一点空：上次停在最新一屏时，右侧有几根的空位
            chart.timeScale().setVisibleLogicalRange({ from: a, to: b >= clean.length ? clean.length + 6 : b });
            restored = true;
          }
        }
      } catch { /* 记录坏了就用默认值 */ }

      if (!restored) {
        // 500 根全展开会把价格压成一条线，日内用不上。默认只看最近 160 根。
        const from = Math.max(0, clean.length - 160);
        chart.timeScale().setVisibleLogicalRange({ from, to: clean.length + 6 });
      }
    };

    /**
     * 整段重画，但**不碰视口**。
     *
     * 前面插进来一段历史、或者拿到一份更旧的快照（REST 的缓存可能落后于 WebSocket），
     * 都走这里。setData 之后库会按时间把视口稳住，所以不动就对了；
     * 以前这两种情况都调 fullLoad()，那会顺手把视口摆回最新的一屏 —— 正看着历史的人
     * 会被弹回最右边，看着就是「画面转移了一下」。
     */
    const redraw = (clean: PaintedBar[]) => {
      // 重画之前先记下「正在看哪一段时间」，重画完再按时间放回去
      const span = chart.timeScale().getVisibleRange();
      price.setData(clean.map(point));
      line.setData(lineData(clean));
      vol.setData(clean.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(46,211,160,0.28)' : 'rgba(255,95,109,0.28)',
      })));
      lastTimeRef.current = clean[clean.length - 1]?.time ?? null;
      firstTimeRef.current = clean[0]?.time ?? null;
      countRef.current = clean.length;
      /**
       * 按时间把视口放回去。
       *
       * 不能指望 setData 自己稳住：前面插进七千根之后，库把「逻辑下标 840~1006」原样留着，
       * 而那已经是三个月前的一段。这里换算成时间再找回来，看历史的就不会被弹走，
       * 第一次进来看到的也是最新那一屏。
       */
      if (span !== null) {
        const a = firstIndexAtOrAfter(clean, span.from as number);
        const b = firstIndexAtOrAfter(clean, span.to as number);
        if (b - a >= 2) {
          // 原来停在最新一屏（右边还有余量）的，重画后要留在原地，别把空隙吃掉
          const to = b >= clean.length ? clean.length + 6 : b;
          try { chart.timeScale().setVisibleLogicalRange({ from: a, to }); } catch { /* 区间不合法就算了 */ }
        }
      }
    };

    try {
      const cleanBars = painted();
      const prevFirst = firstTimeRef.current;
      const prevCount = countRef.current;
      /**
       * 数据的「形状」变了：左边补进来一段，或者左边被裁掉一段。
       *
       * 以前只看「根数变多且最左时间更早」。可是往前补到上限时根数不再变，
       * 那个条件就不成立，补进来的历史掉进增量分支 —— 而增量只写最后两根，
       * 于是左边一直是空的，看着就是 K 线缺了一段。
       * 现在只要最左那根的时间变了，就整段重画。
       */
      const headMoved = prevFirst != null && cleanBars[0]!.time !== prevFirst;
      if (lastKeyRef.current === resetKey && (headMoved || cleanBars.length < prevCount)) {
        /**
         * 这里不动视口，一个像素都不动。
         *
         * 拿 5.2.1 的库实测过：setData 前面插进去一千根之后，视口里的时间是原封不动的
         * （逻辑区间会自己从 0~160 变成 1000~1160，也就是同一批 K 线）。
         * 以前那版按「补进来多少根」再平移一次，等于把画面往右推一整页 —— 那才是
         * 「转移一下画面才显示 K 线」的来源。前面裁掉数据时同理，库也自己稳住。
         */
        redraw(cleanBars);
        /**
         * 人还贴着左边就接着要下一页。
         * 一直翻到「离边缘还有两屏」或者交易所那头到头为止 —— 这样拖的时候是连着出，
         * 而不是停下来等一页、再拖、再等一页。
         */
        const after = chart.timeScale().getVisibleLogicalRange();
        if (after && after.from < PREFETCH_BARS) needOlderRef.current?.(after.from);
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
      // 增量写不进去，整段重画 —— 但仍然不碰视口。
      const newest = cleanBars[cleanBars.length - 1]!;
      const applied = lastTimeRef.current;
      if (applied != null && newest.time < applied) {
        redraw(cleanBars);
        return;
      }
      /**
       * 中间那个洞补回来了：最后一根没变，根数却变多了。
       *
       * 增量走的是 update()，它不接受比图上最后一根更早的时间 —— 补在中间的那几根
       * 根本写不进去，图上会一直缺着。这种情况整段重画一次。
       */
      if (applied != null && newest.time === applied && cleanBars.length > prevCount) {
        redraw(cleanBars);
        return;
      }
      // 中间漏了一大段（切币种、重连之后补回来的），整段重画比逐根 update 快得多

      /**
       * 增量：从图上最后一根开始往后写。
       *
       * 以前固定只写最后两根。WebSocket 掉线重连、或者连着几帧没收到的时候，
       * 中间漏掉的那几根就永远补不上，最新那一段看着是缺的。
       * 现在按时间找起点：正常情况只写一两根，漏了几根就补几根。
       * update() 不接受比图上最后一根更早的时间，起点用 applied 兜住就不会抛。
       */
      const start = applied == null ? cleanBars.length - 1 : firstIndexAtOrAfter(cleanBars, applied);
      if (cleanBars.length - start > 500) { redraw(cleanBars); return; }
      for (let i = Math.max(0, start); i < cleanBars.length; i += 1) {
        const b = cleanBars[i]!;
        if (applied != null && b.time < applied) continue;
        writePrice(b);
        writeLine(b);
        writeVol(b);
        lastTimeRef.current = b.time;
      }
      // 这两个也一起更新：不更新的话，下一次「左边是不是动过」会拿旧值比，判断全乱
      firstTimeRef.current = cleanBars[0]!.time;
      countRef.current = cleanBars.length;
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
    let saveTimer = 0;
    const handler = () => {
      // 图还没画上这一份数据时（挂载瞬间、刚切币种），range 会是 {0,0} 之类，
      // 那不是用户拖到了最左，别把它当成要历史。
      if (countRef.current === 0 || lastKeyRef.current !== resetKey) return;
      const r = ts.getVisibleLogicalRange();
      if (!r) return;

      // 拖动时这个回调很密，攒一下再写
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        // 存时间，不存下标：下次拉到的根数和这次不一样
        const vr = ts.getVisibleRange();
        if (vr) {
          try { localStorage.setItem(viewKey, JSON.stringify({ fromTime: vr.from, toTime: vr.to })); } catch { /* 存不了就算了 */ }
        }
        // 提示跟着可视范围走：缩到有成交的那一段，那句「成交稀疏」就该自己消失
        refreshSparse();
      }, 400);

      /**
       * 别让人拖到数据左边去。
       *
       * 逻辑区间允许负数，拖过头左边就是一整片空白 —— 数据其实一根没少，
       * 但看着就是「K 线缺了一大段」，而且拖到那里也不会再有新页进来。
       *
       * 拖动中的在同一帧里改区间会被图库忽略，得挪到下一帧再拉回来；
       * 拉回来后停一小会儿，让下一批拖动事件重新触发，形成「到边就回弹」。
       */
      // 一帧只拉一次：再密也救不了，反而会和用户的手感打架
      if ((r.from < -1 || r.to < 8) && !clampingRef.current) {
        clampingRef.current = true;
        const span = Math.max(80, r.to - r.from);
        requestAnimationFrame(() => {
          clampingRef.current = false;
          try { ts.setVisibleLogicalRange({ from: 0, to: span }); } catch { /* 区间不合法就算了 */ }
        });
      }

      // 贴到最左边了：到头说明这时候才有意义
      setAtEdge(r.from < 1.5);

      // 离最左边还有两屏的距离就先要：贴到边缘再要，得干等交易所一秒多
      if (r.from < PREFETCH_BARS) onNeedOlder(r.from);
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    /**
     * 开局的视口是在订阅之前设的，那一次变化没人接，所以历史要等用户拖一下才开始补。
     * 这里主动问一次。
     */
    const head = ts.getVisibleLogicalRange();
    if (head && countRef.current > 0 && lastKeyRef.current === resetKey && head.from < PREFETCH_BARS) {
      onNeedOlder(head.from);
    }
    return () => {
      window.clearTimeout(saveTimer);
      ts.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [onNeedOlder, resetKey, viewKey, refreshSparse]);

  // ---- 新数据落地之后（含实时补课）重新数一次平价占比 ----
  useEffect(() => {
    // 等这一帧把图写完再量视口，早了拿到的是上一次的区间
    const id = requestAnimationFrame(() => refreshSparse());
    return () => cancelAnimationFrame(id);
  }, [bars, resetKey, refreshSparse]);

  // ---- 图上的横线：方案止损止盈、持仓均价、挂着的限价单、支撑阻力 ----
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

    /** 同一个合约多空两边都持有时，标签上得写清楚是哪一边的止损止盈 */
    const twoSides = positions.length > 1;

    // 真实挂着的止损止盈排最前：这是交易所里已经存在的单，到价会真的把仓平掉。
    // 方案价只是「打算」，排在持仓成本和挂单后面。
    for (const p of positions) {
      const cur = bracketOf(priceOrders, p.contract, p.direction);
      const tag = twoSides ? (p.direction === 'long' ? '多' : '空') : '';
      if (cur.stop) {
        items.push({
          price: cur.stop.triggerPrice, rank: 0, color: DOWN, width: 2, style: LineStyle.Solid,
          title: tag + '止损', wants: true,
        });
      }
      if (cur.target) {
        items.push({
          price: cur.target.triggerPrice, rank: 0, color: UP, width: 2, style: LineStyle.Solid,
          title: tag + '止盈', wants: true,
        });
      }
    }

    if (bracket) {
      // 计划入场不是现价线：现价线跟着价格跑，价格一走开就看不出原本打算在哪进了。
      // 这三条是算出来的，没有一张单对应它，所以画虚线、抢标签也排在真单后面。
      items.push(
        { price: bracket.stop, rank: 2.2, color: DOWN, width: 1, style: LineStyle.Dashed, title: '计划止损', wants: true },
        { price: bracket.target, rank: 2.2, color: UP, width: 1, style: LineStyle.Dashed, title: '计划止盈', wants: true },
        { price: bracket.entry, rank: 2.4, color: ENTRY, width: 1, style: LineStyle.Dashed, title: '计划入场', wants: true },
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

    // 挂着的限价单：成交之前它只是一个打算，用虚线跟已成交的持仓区分。
    // 抢标签排在持仓均价之后、计划入场之前 —— 止损止盈和成本比它要紧，
    // 但它是交易所里真挂着的单，比算出来的计划和档位更该报出价来。
    for (const o of pendingOrderLines(orders)) {
      items.push({
        price: o.price,
        rank: 1.5,
        color: PENDING,
        width: 2,
        style: LineStyle.Dashed,
        title: o.label,
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
  }, [levels, bracket, positions, orders, priceOrders]);

  /**
   * 右侧价格轴的小数位跟着合约的最小变动价走。
   * 原来是写死的「1000 以上留 1 位」，ETH 这种 0.01 一跳的合约，
   * 轴上的 2056.7 和摘要里的 2056.65 就对不上了 —— 同一个价位写出两个数。
   * 用 applyOptions 改，不重建图表，画线和视口都不会丢。
   */
  useEffect(() => {
    chartRef.current?.applyOptions({
      localization: { locale: 'zh-CN', priceFormatter: (p: number) => fmtPrice(p, priceRound) },
    });
  }, [priceRound]);

  /**
   * 价格轴的最小跨度。
   *
   * 一整屏都是没成交的平价 K 线时，数据的最高和最低只差一个最小变动价，
   * 库就把坐标轴压到那么窄 —— 每根 K 线的影线（也是撑开后的那一个跳动）
   * 正好占满整屏，于是满屏竖条，比原来的断续小方块还难看。
   * 这里把可视区的最小跨度兜到「0.2% 或 20 个跳动」里大的那个，撑开的线就回到它该有的一像素。
   */
  useEffect(() => {
    const provider: AutoscaleInfoProvider = (base) => {
      const info = base();
      if (!info || !info.priceRange) return info;
      const { minValue, maxValue } = info.priceRange;
      const mid = (minValue + maxValue) / 2;
      const floor = Math.max(Math.abs(mid) * 0.002, priceRound * 20);
      if (!(maxValue - minValue < floor)) return info;
      return { ...info, priceRange: { minValue: mid - floor / 2, maxValue: mid + floor / 2 } };
    };
    priceRef.current?.applyOptions({ autoscaleInfoProvider: provider });
    lineRef.current?.applyOptions({ autoscaleInfoProvider: provider });
  }, [priceRound]);

  // ---- 工具切换 ----
  useEffect(() => {
    dmRef.current?.setTool(tool);
  }, [tool]);

  /**
   * 图左上角那块持仓摘要：张数、开仓、标记、已盈亏，以及打到止损止盈各平出多少钱。
   * 数字全部由 pnlOf 现算 —— 和持仓卡、和交易所是同一个口径，多空两边也一样。
   */
  const positionViews = positions.map((p) => {
    const cur = bracketOf(priceOrders, p.contract, p.direction);
    return {
      p,
      cur,
      // 数据停更时别拿实时的价去配旧的持仓：那一行会变成「旧开仓 + 新价格」，
      // 看着就是个自相矛盾的数字。停更时整块退回快照自己的价。
      live: pnlOf(p, stale ? 0 : markPrice, multiplier),
      atStop: cur.stop ? pnlOf(p, cur.stop.triggerPrice, multiplier).pnl : null,
      atTarget: cur.target ? pnlOf(p, cur.target.triggerPrice, multiplier).pnl : null,
    };
  });

  return (
    <>
      <div className="chart-tools">
        <div className="seg">
          {INTERVALS.map((i) => (
            <button key={i} className={i === interval ? 'on' : ''} onClick={() => onIntervalChange(i)}>{i}</button>
          ))}
        </div>
        <div className="tool-divider" />
        {/* 画法：自动只在「平价线过半」时改折线，冷门币不再是一排断续的小方块 */}
        {(['auto', 'candle', 'line'] as const).map((m) => (
          <button
            key={m}
            title={m === 'auto'
              ? '自动：无成交占比过半的合约改画折线，其余画 K 线'
              : m === 'candle' ? '只看 K 线' : '只看收盘价折线（成交稀疏时更清楚）'}
            className={`tool-btn ${mode === m ? 'on' : ''}`}
            onClick={() => pickMode(m)}
          >
            {m === 'auto' ? '自动' : m === 'candle' ? 'K线' : '折线'}
          </button>
        ))}
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
        {bars.length > 0 && (
          <span className="dim" style={{ fontSize: 10.5 }} title="已经拿到的 K 线根数，以及最老那一根的时间">
            {backfilling ? '正在补历史 · ' : ''}{bars.length} 根 · 最早 {fmtDate(bars[0]!.time)}
          </span>
        )}
        <span className="dim" style={{ fontSize: 10.5 }}>画线自动存本地</span>
      </div>

      <div className="chart-wrap">
        <div className="chart-host" ref={hostRef} />
        {legend && (
          <div className="chart-badge">
            <span>O {legend.o ?? '—'}</span>
            <span className="up">H {legend.h ?? '—'}</span>
            <span className="down">L {legend.l ?? '—'}</span>
            <span>C {legend.c}</span>
            <span>V {Math.round(legend.v)}</span>
          </div>
        )}
        {historyEnd && atEdge && (
          <div className="chart-edge">已到交易所能给的最早一根（每个周期约一万根） · 换更大周期看更早</div>
        )}
        {sparse && flatShare >= SPARSE_SHARE && (
          <div className="chart-sparse">
            该合约成交稀疏 · 可视 {sparse.count} 根里 {sparse.flat} 根没有成交
            {drawMode === 'line' ? '（折线只连收盘价）' : '（灰色为无成交 K 线）'}
          </div>
        )}
        {stale && (
          <div className="chart-stale">
            持仓数据停更 {Math.round(stale.ageMs / 1000)} 秒 · 图上的均价和止损止盈是旧快照
          </div>
        )}
        {positionViews.length > 0 && (
          <div className={'chart-pos' + (stale ? ' stale' : '')}>
            {positionViews.map(({ p, cur, live, atStop, atTarget }) => {
              const isLong = p.direction === 'long';
              return (
                <div key={p.direction} className={'cp-row ' + (isLong ? 'long' : 'short')}>
                  <div className="cp-head">
                    <span className="cp-dir">
                      {isLong ? '多' : '空'} {Math.abs(p.size)} 张 · {p.leverage}x
                    </span>
                    <span className={'cp-pnl ' + (live.pnl >= 0 ? 'up' : 'down')}>
                      {fmtMoney(live.pnl)}
                      {live.pct !== null && <span className="dim"> ({fmtPct(live.pct, 2)})</span>}
                    </span>
                  </div>
                  <div className="cp-mid">
                    <span>开仓 {fmtPrice(p.entryPrice, priceRound)}</span>
                    <span>标记 {fmtPrice(live.price, priceRound)}</span>
                  </div>
                  <div className="cp-prot">
                    <span className={cur.stop ? 'down' : 'none'}>
                      {cur.stop
                        ? `止损 ${fmtPrice(cur.stop.triggerPrice, priceRound)} → ${fmtMoney(atStop ?? 0)}`
                        : '止损 未设'}
                    </span>
                    <span className={cur.target ? 'up' : 'none'}>
                      {cur.target
                        ? `止盈 ${fmtPrice(cur.target.triggerPrice, priceRound)} → ${fmtMoney(atTarget ?? 0)}`
                        : '止盈 未设'}
                    </span>
                  </div>
                </div>
              );
            })}
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
