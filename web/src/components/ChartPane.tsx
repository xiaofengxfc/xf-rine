import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
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
  type UTCTimestamp,
} from 'lightweight-charts';
import { DrawingManager, defaultStyleFor, type DrawingKind } from 'lightweight-charts-drawing';
import type { Bar, OpenOrder, Position, Zone } from '../lib/api.ts';
import { firstIndexAtOrAfter, normalizeBars, paintBars, sparseStats, type PaintedBar } from '../lib/candles.ts';
import { viewportRange, type ViewSpan } from '../lib/viewport.ts';
import { pendingOrderLines } from '../lib/orderLines.ts';
import { pnlOf } from '../lib/position.ts';
import { fmtDate, fmtMoney, fmtPct, fmtPrice } from '../lib/format.ts';
import { chartColors, getTheme, useTheme, type ChartColors } from '../lib/theme.ts';

const UP = '#2ed3a0';
const DOWN = '#ff5f6d';

/** 真实持仓成本 */
const HOLDING = '#ffcf4d';
/** 强平价：仓位被交易所接管的那个价，比成本线更该看见 */
const LIQ = '#ff7a45';
/** 还挂着的限价单 */
const PENDING = '#b58bff';
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
 * 右侧空位的默认根数：停在最新一屏时，图上右边空出来这么多格。
 * 和建图时 timeScale.rightOffset 是同一个数 —— 恢复视口时要靠它把空位还回去。
 */
const DEFAULT_RIGHT_MARGIN = 6;

/**
 * 松手之后还要等这么久才算「手势结束」。
 * 触摸屏松手后库还会惯性滑一段（KineticAnimation），那几帧里写视口一样会被顶掉。
 */
const GESTURE_HOLD_MS = 220;

/**
 * 手势看门狗：按下之后这么久还没等到抬起，就当作抬起事件丢了
 * （切后台、被系统手势打断、指针捕获被抢走），把标记放掉。
 * 没有它的话，一次丢事件就让视口校正永远不生效，补历史时画面会越走越歪。
 */
const GESTURE_LOST_MS = 3000;

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
  zones: Zone[];

  /** 当前合约的真实持仓，用来在图上标出成本线（双向模式可能多空各一条） */
  positions: Position[];
  /** 当前合约还挂着的委托，限价单在图上画一条线，成交或撤掉就消失 */
  orders: OpenOrder[];

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
  /**
   * 周期按钮显示哪几个。
   *
   * 默认是交易所那七档；本地数据模式下换成文件里真有的那些（D1 / H1 / 15min…），
   * 否则用户点一个目录里没有的周期，只会得到一张空图。
   */
  intervals?: string[];
  onManualLevels: (prices: number[]) => void;
  /** 解锁并连上了，图上那个「市价平」才可按 */
  canClose: boolean;
  /** 图上直接平仓。和持仓卡里那个是同一个接口，只是挪到手指边上 —— 手机上原来要滑到底才够得着 */
  onClosePosition: (contract: string, direction: 'long' | 'short') => void;
  /**
   * 右键取价：把鼠标所在的价格带进下单面板的 限价 / 止损 / 止盈，
   * 或者直接覆盖当前持仓的止损止盈。四个动作在 `RightClickPick` 里定义。
   */
  onPickPrice: (price: number, what: PricePick) => void;
  /** 这个合约上有没有仓。有仓才给「覆盖持仓止损/止盈」那两项 */
  hasPosition: boolean;
  /**
   * 研究台模式：只留 K 线和关键位，藏掉下单相关的互动。
   *
   * 研究台看的是本地历史数据，右键「带入下单面板」、图上平仓、周期按钮那些
   * 在这里要么没有意义（本地数据没有合约参数），要么已经在页面上另有一套控件。
   */
  research?: boolean;
}

/** 右键菜单里的四个去处 */
export type PricePick = 'limit' | 'stop' | 'target' | 'posStop' | 'posTarget';

export default function ChartPane({
  contract, interval, bars, zones, positions, orders, multiplier, markPrice, priceRound,
  stale, resetKey, loading, onNeedOlder, historyEnd, backfilling, onIntervalChange, onManualLevels,
  intervals = INTERVALS as unknown as string[],
  canClose, onClosePosition, onPickPrice, hasPosition, research = false,
}: Props) {
  /** 右键菜单要不要弹，靠 ref 读：它挂在图表初始化那次 effect 里，不能进依赖数组 */
  const researchRef = useRef(false);
  researchRef.current = research;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  /** 收盘价折线：成交稀疏的合约用这条，比一排小方块看着清楚 */
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const dmRef = useRef<DrawingManager | null>(null);
  const levelLinesRef = useRef<IPriceLine[]>([]);

  const barsRef = useRef<Bar[]>(bars);
  /** 补历史这件事要在 K 线落地之后再催一次，用 ref 拿最新的回调 */
  const needOlderRef = useRef(onNeedOlder);
  needOlderRef.current = onNeedOlder;
  /** 这一帧已经排了一次「把视口拉回数据边缘」，别排队排成一串 */
  const clampingRef = useRef(false);
  /** 手指还在图上（拖动、缩放、惯性滑动）。这期间一律不写视口，见 placeView */
  const gestureRef = useRef(false);
  /**
   * 手势期间欠下的那次视口校正。
   * 按时间记，不按下标：等手松开时可能又补进来几页，下标早就过期了。
   */
  const pendingViewRef = useRef<ViewSpan | null>(null);

  /**
   * 按时间把视口放到某一段上。手势期间只记账、不动手。
   *
   * 为什么不能动手：库的拖动是每帧按「按下那一刻的偏移 + 指头位移」现算位置的，
   * 我们这时候写一次 setVisibleLogicalRange，它下一帧就按自己的算法盖回去 ——
   * 手指明明还在往右滑，画面却在中间跳了一下。而且这一笔是排到下一帧才生效的，
   * 就算按下之前就排好了队，也会落在手指拖动的过程里。
   *
   * 所以手势期间把要做的事记下来，等松手（再等惯性滑完）补一次。
   */
  const placeView = useCallback((span: ViewSpan, list: Bar[] = barsRef.current) => {
    if (gestureRef.current) {
      // 手还没松开：记下来，等松开（含惯性滑动）再补，见下面建图那段
      pendingViewRef.current = span;
      return;
    }
    pendingViewRef.current = null;
    const chart = chartRef.current;
    if (!chart) return;
    const range = viewportRange(list, span);
    if (!range) return;
    try { chart.timeScale().setVisibleLogicalRange(range); } catch { /* 区间不合法就算了 */ }
  }, []);
  /** 建图、数据那些 effect 只依赖 storageKey，拿的是那天的闭包，所以从这里取最新的 */
  const placeViewRef = useRef(placeView);
  placeViewRef.current = placeView;
  /**
   * 「把图上当前的横向画线报给上层」。
   *
   * 图一重建（换币种、换周期）这个函数就换一个实例，所以放进 ref：
   * 数据 effect 里导入本合约存档的画线之后，要靠它把带子上的「手动」重算一遍 ——
   * 光靠 add/remove 那几个事件不行，importJSON 不发这些事件。
   * 少了这一步，上一个币种画的线会挂在新币种的档位带上，还按新币的价格算百分比。
   */
  const collectRef = useRef<() => void>(() => {});
  const lastKeyRef = useRef<string>('');
  /** 图上最后一根 K 线的时间。update() 不接受比它更早的时间，必须自己挡。 */
  const lastTimeRef = useRef<number | null>(null);
  /** 图上最左边那根的时间和总根数，用来识别「往前补了一段历史」 */
  const firstTimeRef = useRef<number | null>(null);
  const countRef = useRef(0);
  /** 画图用的那版 K 线（平价线已撑开）。同一份数据只算一次，别每秒拷两万根 */
  const paintRef = useRef<{ src: Bar[] | null; tick: number; out: PaintedBar[] }>({ src: null, tick: -1, out: [] });
  /**
   * 当前这套色板。
   *
   * 图里的颜色分两类：底色、网格那类是 series/chart 的**选项**，applyOptions 就能换；
   * 平价线的中性灰和成交量的淡色是**写在每根数据上**的，换主题只能整段重画一遍。
   * 后者发生在建图、补数据那些 effect 里，它们只依赖 storageKey，拿的是建图那天的闭包 ——
   * 所以要有一个能从外面读到当前色板的地方，否则重画出来的还是旧主题的颜色。
   */
  const colorsRef = useRef<ChartColors>(chartColors(getTheme()));
  /** 图上这批 K 线是用哪套主题画的。变了就说明颜色过期了，得整段重画一次 */
  const paintThemeRef = useRef<string>('');
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

  /** 画线和视口按币种 + 周期各存一份，也是「图表实例」的身份 */
  const storageKey = `xf-rine:drawings:${contract}:${interval}`;
  const viewKey = `xf-rine:view:${contract}:${interval}`;

  /** 画法偏好。默认自动：视口里平价线过半就改画折线 */
  const [mode, setMode] = useState<ChartMode>(readMode);
  const flatShare = sparse ? sparse.flat / Math.max(1, sparse.count) : 0;
  const drawMode: 'candle' | 'line' = mode === 'auto'
    ? (sparse !== null && flatShare >= SPARSE_SHARE ? 'line' : 'candle')
    : mode;

  const pickMode = useCallback((next: ChartMode) => {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* 存不了就算了 */ }
  }, []);
  const [tool, setTool] = useState<DrawingKind | null>(null);
  /** 视口已经贴到最左边那根了。到头说明只在贴边时才显示，不然一开页面就挂在图上 */
  const [atEdge, setAtEdge] = useState(false);
  /** 图上那一步「确认平掉」按了没有。按合约+方向记，双向持仓时两边各管各的 */
  const [closing, setClosing] = useState<string | null>(null);
  const [legend, setLegend] = useState<{ o: number | null; h: number | null; l: number | null; c: number; v: number; t: number } | null>(null);
  /** 右键菜单：贴着鼠标的位置画，带了它取到的那根 K 线所在的价格 */
  const [menu, setMenu] = useState<{ x: number; y: number; price: number; time: number | null } | null>(null);

  barsRef.current = bars;
  /** 右键取价按这个吸附。建图的 effect 只跑一次，所以走 ref 拿最新的 */
  const roundRef = useRef(priceRound);
  roundRef.current = priceRound;
  /** 右键菜单里的动作也走 ref：effect 里挂的监听只挂一次 */
  const pickRef = useRef(onPickPrice);
  pickRef.current = onPickPrice;

  // ---- 建图 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // canvas 里读不到 CSS 变量，配色只能从这份色板来（跟着当前主题）
    const c = colorsRef.current;
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: c.background },
        textColor: c.text,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: c.grid },
        horzLines: { color: c.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: c.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: c.crosshairLabel },
        horzLine: { color: c.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: c.crosshairLabel },
      },
      rightPriceScale: {
        borderColor: c.border,
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: c.border,
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
      priceLineColor: c.priceLine,
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
      color: c.line,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 3,
      visible: false,
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
    /** 把图上当前的横向画线报给上层。画线和导入之后都要走它 */
    const collect = () => {
      const prices: number[] = [];
      for (const d of dm.drawings()) {
        if (d.kind === 'horizontal-line' && d.points[0]) prices.push(d.points[0].price);
      }
      onManualLevels(prices);
    };
    collectRef.current = collect;
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

    /**
     * 手势守卫：手指在图上就记一笔。
     *
     * 拖动、缩放期间不写视口（原因见 placeView）；松手之后还要多等一会儿：
     * 触摸屏松开时库会接着惯性滑一段，那几帧同样不能被我们插进去。
     *
     * held 记的是「现在有几根手指按在图上」：别处（按钮、列表）的抬手事件也会冒到
     * window 上，光看「有没有抬手」会把手势提前放掉 —— 一边拖着图、一边点了别处就中招。
     */
    const held = new Set<number>();
    let releaseTimer = 0;
    let lostTimer = 0;
    /** 手势结束（或抬起事件丢了）：放开标记，把欠下的那次校正补上 */
    const settle = () => {
      window.clearTimeout(lostTimer);
      lostTimer = 0;
      held.clear();
      gestureRef.current = false;
      // 这段时间里数据可能又变了，所以还是按时间放，不按当时算出来的下标
      const pending = pendingViewRef.current;
      pendingViewRef.current = null;
      if (pending) placeViewRef.current(pending);
    };
    const onDown = (e: PointerEvent) => {
      held.add(e.pointerId);
      window.clearTimeout(releaseTimer);
      releaseTimer = 0;
      window.clearTimeout(lostTimer);
      gestureRef.current = true;
      lostTimer = window.setTimeout(settle, GESTURE_LOST_MS);
    };
    const onMove = () => {
      // 移动只说明手还在：把看门狗往后推一点，但别推太远（丢事件时要能自愈）
      if (gestureRef.current && lostTimer !== 0) {
        window.clearTimeout(lostTimer);
        lostTimer = window.setTimeout(settle, GESTURE_LOST_MS);
      }
    };
    const onUp = (e: PointerEvent) => {
      held.delete(e.pointerId);
      if (held.size > 0) return; // 还有手指在图上（双指缩放），没松手
      window.clearTimeout(releaseTimer);
      // 松手之后还有惯性滑动，那几帧同样不能插进去，等它滑完再结算
      releaseTimer = window.setTimeout(settle, GESTURE_HOLD_MS);
    };
    // 用捕获阶段：画线工具按下时会自己 stopPropagation（挡住图上其它手势），
    // 冒泡阶段的监听收不到那一次 —— 而那恰恰也是「手指正按在图上」的时候。
    const CAPTURE = { capture: true, passive: true } as const;
    host.addEventListener('pointerdown', onDown, CAPTURE);
    host.addEventListener('pointermove', onMove, CAPTURE);
    window.addEventListener('pointerup', onUp, CAPTURE);
    window.addEventListener('pointercancel', onUp, CAPTURE);

    /**
     * 右键取价。
     *
     * 价格从坐标轴换算，不从中枢价猜：鼠标停在哪一根价格上就该带哪一个，
     * 吸到最小变动位上再进菜单（带一个 73590.8123 进止损框只会让交易所拒单）。
     * 落在 K 线上时顺便记下那根的时间，菜单里写出来，免得「我点的是那一根」变成一句空话。
     */
    const onContextMenu = (e: MouseEvent) => {
      const box = host.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      // 坐标轴那一块不给取价：那里对应的价格没有意义
      if (x < 0 || y < 0 || x > box.width || y > box.height) return;
      const raw = price.coordinateToPrice(y - host.clientTop);
      if (raw === null || !Number.isFinite(Number(raw))) return;
      const value = Number(raw);
      const step = roundRef.current > 0 ? roundRef.current : 0;
      const snapped = step > 0 ? Math.round(value / step) * step : value;
      let time: number | null = null;
      const t = chart.timeScale().coordinateToTime(x);
      if (t !== null) time = Number(t);
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x, y, price: snapped, time });
      // 研究台不看盘下单：右键取价那一套（带入限价/止损/止盈）在那儿没有去处
      if (researchRef.current) return;
    };
    host.addEventListener('contextmenu', onContextMenu);

    chartRef.current = chart;
    priceRef.current = price;
    lineRef.current = line;
    volRef.current = vol;
    dmRef.current = dm;

    return () => {
      for (const u of unsubs) u();
      window.clearTimeout(saveTimer);
      window.clearTimeout(releaseTimer);
      window.clearTimeout(lostTimer);
      host.removeEventListener('contextmenu', onContextMenu);
      // 摘监听时 capture 必须和挂的时候一致，否则摘不掉（会留着引用旧的 ref）
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      gestureRef.current = false;
      pendingViewRef.current = null;
      dm.destroy();
      chart.remove();
      chartRef.current = null;
      priceRef.current = null;
      lineRef.current = null;
      volRef.current = null;
      dmRef.current = null;
      // 图已经销毁：这时候再 collect 就是对着一个没了的画线管理器读
      collectRef.current = () => {};

      levelLinesRef.current = [];
      lastTimeRef.current = null;
    };
    // onManualLevels 有意不放进依赖：它是每次渲染新建的箭头函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  /**
   * 换主题：canvas 不吃 CSS 变量，得把底色、网格、坐标轴重新贴一遍。
   * 涨跌色两套一样不用动；平价线的灰和成交量的淡色要按新主题重画一遍（见数据那条 effect）。
   */
  const theme = useTheme();
  // 色板在渲染期就同步过去：数据那条 effect 只依赖 storageKey，靠 effect 的先后顺序不可靠
  colorsRef.current = chartColors(theme);
  useEffect(() => {
    const c = chartColors(theme);
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.background }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      crosshair: {
        vertLine: { color: c.crosshair, labelBackgroundColor: c.crosshairLabel },
        horzLine: { color: c.crosshair, labelBackgroundColor: c.crosshairLabel },
      },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    priceRef.current?.applyOptions({ priceLineColor: c.priceLine });
    lineRef.current?.applyOptions({ color: c.line });
    // 依赖里带 storageKey：切周期会重建整张图，新图也得贴成当前这套
  }, [theme, storageKey]);

  /**
   * 画法要在「图重建之后」重新贴一次。
   *
   * 图表实例归 storageKey（币种 + 周期）管，切周期就整张重建：新建的 K 线序列默认可见、
   * 折线序列默认藏着。只依赖 drawMode 的话，切周期时这个值没变、effect 不会重跑 ——
   * 选了「折线」的人切一次周期，图就变回 K 线，而且不会自己变回来。
   *
   * 位置也有讲究：它必须在建图那个 effect 之后声明。同一个 commit 里 effect 按声明顺序执行，
   * 摆在前面的话，贴的是马上要被销毁的旧图。
   */
  useEffect(() => {
    priceRef.current?.applyOptions({ visible: drawMode === 'candle' });
    lineRef.current?.applyOptions({ visible: drawMode === 'line' });
  }, [drawMode, storageKey]);

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
        color: colorsRef.current.flat, borderColor: colorsRef.current.flat, wickColor: colorsRef.current.flat,
      }
      : { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
    const writePrice = (b: PaintedBar) => price.update(point(b));
    /** 折线只用收盘价：稀疏合约看着就是价格的台阶，比一排小方块清楚 */
    const writeLine = (b: PaintedBar) => line.update({ time: b.time as UTCTimestamp, value: b.close });
    const lineData = (list: PaintedBar[]) => list.map((b) => ({ time: b.time as UTCTimestamp, value: b.close }));
    /**
     * 成交量的颜色是逐根写在数据上的（涨绿跌红），台账里没有「按根变色」这个选项。
     * 深浅两套的浓淡不一样：同样的 0.28 落在白底上等于没画。
     */
    const volColor = (b: Bar) => (b.close >= b.open ? colorsRef.current.volumeUp : colorsRef.current.volumeDown);
    const writeVol = (b: Bar) => vol.update({
      time: b.time as UTCTimestamp,
      value: b.volume,
      color: volColor(b),
    });
    const fullLoad = () => {
      const clean = painted();
      price.setData(clean.map(point));
      line.setData(lineData(clean));
      vol.setData(clean.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: volColor(b),
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
          // 右边留一点空：上次停在最新一屏时，右侧就是那几根空位。
          // 少于 8 根的窗口恢复出来和没有一样，不认这段记录。
          const range = viewportRange(
            clean,
            { fromTime: saved.fromTime as number, toTime: saved.toTime as number, margin: DEFAULT_RIGHT_MARGIN },
            8,
          );
          if (range) {
            chart.timeScale().setVisibleLogicalRange(range);
            restored = true;
          }
        }
      } catch { /* 记录坏了就用默认值 */ }

      if (!restored) {
        // 500 根全展开会把价格压成一条线，日内用不上。默认只看最近 160 根。
        const from = Math.max(0, clean.length - 160);
        chart.timeScale().setVisibleLogicalRange({ from, to: clean.length + DEFAULT_RIGHT_MARGIN });
      }
    };

    /**
     * 整段重画。
     *
     * 前面插进来一段历史、或者拿到一份更旧的快照（REST 的缓存可能落后于 WebSocket），
     * 都走这里。setData 之后库会按时间把视口稳住，所以正常情况下一个像素都不用动 ——
     * 以前这两种情况都调 fullLoad()，那会顺手把视口摆回最新的一屏，正看着历史的人
     * 会被弹回最右边，看着就是「画面转移了一下」。
     *
     * 但「正常情况下」得验一下再说：重画前后各读一次看得见的那段时间，真的变了才补一刀
     * （见下面的比较）。之前是每次都照着记下的时间重设一遍，等于每补一页就动一次缩放。
     */
    const redraw = (clean: PaintedBar[]) => {
      const ts = chart.timeScale();
      // 重画之前先记下「正在看哪一段时间」，以及右边界之外还留了几根空位
      const span = ts.getVisibleRange();
      const logical = ts.getVisibleLogicalRange();
      const beforeLen = countRef.current;
      /**
       * 空位只能从逻辑区间量：getVisibleRange() 会把右边界夹在最后一根 K 线上，
       * 停在最新一屏时它看不出右边还空着几根。少了这几根，每补一页历史画面就往左挪。
       */
      const margin = logical && beforeLen > 0 ? Math.max(0, logical.to - (beforeLen - 1)) : 0;

      price.setData(clean.map(point));
      line.setData(lineData(clean));
      vol.setData(clean.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: volColor(b),
      })));
      lastTimeRef.current = clean[clean.length - 1]?.time ?? null;
      firstTimeRef.current = clean[0]?.time ?? null;
      countRef.current = clean.length;

      if (!span || typeof span.from !== 'number' || typeof span.to !== 'number') return;
      const now = ts.getVisibleRange();
      /**
       * 库自己把窗口稳住了（看得见的第一根、最后一根一根没变）：一个像素都别动。
       *
       * 以前每次都照着记下的时间再设一遍逻辑区间。问题是 setVisibleLogicalRange 按
       * 「区间里有几根」反推缩放，于是每补一页历史就动一次缩放和右偏移；更麻烦的是这一笔
       * 排在下一帧才生效 —— 用户正拖着的时候，手指刚拖到的位置就被它顶回去。
       * 现在只在库真把窗口挪了（实测某些数据形状下会挪一整页）时，按时间放回去。
       */
      if (now && now.from === span.from && now.to === span.to) return;
      placeViewRef.current({ fromTime: span.from, toTime: span.to, margin }, clean);
    };

    try {
      const cleanBars = painted();
      /**
       * 主题换了：平价线的中性灰和成交量那层淡色是**写在每根数据上**的，
       * applyOptions 只能换底色网格那些选项，换不掉它们 —— 不重画就会留着一半旧配色。
       * 重画走 redraw：换的只是颜色，视口该在哪儿还在哪儿。
       */
      if (paintThemeRef.current && paintThemeRef.current !== theme) {
        paintThemeRef.current = theme;
        redraw(cleanBars);
        return;
      }
      paintThemeRef.current = theme;
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
        /**
         * 导入不发 add/remove 事件，这里补一次。
         * 本合约没存过画线时会报一个空数组，正好把上一个币种留下的「手动」清掉。
         */
        collectRef.current();
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
    // theme 也在依赖里：换主题要按新配色重画一遍（见上面那段）
  }, [bars, resetKey, storageKey, theme]);

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
       *
       * 拉回来只挪右边界（scrollToPosition），不重设逻辑区间：后者会顺手把缩放改成
       * 「刚好放下这么多根」，贴着边拖的时候画面会跟着一缩，看着又是一次跳。
       */
      // 一帧只拉一次：再密也救不了，反而会和用户的手感打架
      if ((r.from < -1 || r.to < 8) && !clampingRef.current) {
        clampingRef.current = true;
        // 左边界回到 0 还差这么多根，往右挪同样多根就贴回数据开头了
        const back = Math.ceil(-r.from);
        requestAnimationFrame(() => {
          clampingRef.current = false;
          if (!(back > 0)) return;
          try { ts.scrollToPosition(ts.scrollPosition() + back, false); } catch { /* 位置不合法就算了 */ }
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

  // ---- 图上的横线：持仓均价、挂着的限价单、支撑阻力 ----
  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;

    for (const line of levelLinesRef.current) price.removePriceLine(line);
    levelLinesRef.current = [];

    const all = barsRef.current;
    const last = all[all.length - 1]?.close ?? 0;

    interface Item {
      price: number;
      /** 越小越排在前面：顺序只决定画线的先后，不再决定谁有资格写字 */
      rank: number;
      color: string;
      width: 1 | 2;
      style: LineStyle;
      title: string;
    }

    const items: Item[] = [];

    for (const p of positions) {
      if (!p.entryPrice || !p.size) continue;
      items.push({
        price: p.entryPrice,
        rank: 1,
        color: HOLDING,
        width: 2,
        style: LineStyle.Solid,
        title: positions.length > 1 ? (p.direction === 'long' ? '多单均价' : '空单均价') : '持仓均价',
      });
    }

    // 强平价：真到这儿仓位就不归你管了。交易所没报这个价就不画。
    for (const p of positions) {
      if (!p.liqPrice || p.liqPrice <= 0) continue;
      items.push({
        price: p.liqPrice,
        rank: 1.2,
        color: LIQ,
        width: 1,
        style: LineStyle.Dashed,
        title: positions.length > 1 ? (p.direction === 'long' ? '多单强平' : '空单强平') : '强平价',
      });
    }

    // 挂着的限价单：成交之前它只是一个打算，用虚线跟已成交的持仓区分
    for (const o of pendingOrderLines(orders)) {
      items.push({
        price: o.price,
        rank: 1.5,
        color: PENDING,
        width: 2,
        style: LineStyle.Dashed,
        title: o.label,
      });
    }

    // 档位按离现价远近排，近的排在前面。
    // 线上写的是**模型概率**：触及概率区分度强（AUC 0.73~0.77），守住概率校准好但排序弱
    // （AUC 0.59~0.61），所以两个都标、都不加「胜率」这种词。
    // 一律画实线：这版算法算出来的强度分没有上限（1.x 到 3.x 都常见），
    // 拿「分数够不够」决定虚实，结果几乎全是淡虚线 —— 就是「支撑阻力看不见了」。
    // 主次靠远近距离分：最近的两条加粗，其余正常。
    const byNear = [...zones].sort((a, b) => Math.abs(a.center - last) - Math.abs(b.center - last));
    const pctOf = (v: number | null) => (v === null ? '—' : Math.round(v * 100) + '%');
    byNear.forEach((z, i) => {
      items.push({
        price: z.center,
        rank: 3 + i * 0.01,
        color: z.zone_type === 'support' ? 'rgba(46,211,160,0.8)' : 'rgba(255,95,109,0.8)',
        width: i < 2 ? 2 : 1,
        style: LineStyle.Solid,
        // 价格按合约的最小变动价写：冷门币一跳 0.00001，toFixed(1) 会把它写成 0.0
        title: (z.zone_type === 'support' ? '支撑 ' : '阻力 ') + fmtPrice(z.center, priceRound)
          + ' · 触及 ' + pctOf(z.p_touch) + ' · 守住 ' + pctOf(z.p_hold)
          + ' · 测试 ' + z.n_events + ' 次'
          + (z.tf_count > 1 ? ' · 共振 ' + z.tf_count : ''),
      });
    });

    items.sort((a, b) => a.rank - b.rank);

    /**
     * 一条线一份标注，一条都不省。
     *
     * 以前这里按「离现价远近」抢位子：只有最近的四条写价，其余既没有轴标签也没有标题；
     * 再叠加一层按可视价格跨度算的拥挤判定，价位挨得近的那些档位连线中间的字都没了。
     * 用户看到的就是「图上只标了几条支撑阻力」。
     *
     * 现在每条都带轴标签和标题。挨在一起的档位，右侧轴上的价签会互相挡住两块，
     * 但线中间那个标题还在，实时价格那个标签也始终压在上面 —— 标全是优先的。
     */
    for (const it of items) {
      const line = price.createPriceLine({
        price: it.price,
        color: it.color,
        lineWidth: it.width,
        lineStyle: it.style,
        axisLabelVisible: true,
        title: it.title,
      });
      levelLinesRef.current.push(line);
    }
  }, [zones, positions, orders, priceRound]);

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
    // storageKey 也是依赖：切周期会重建图表，新图得重新贴一次位数，否则轴上的
    // 2056.7 和摘要里的 2056.65 又对不上了
  }, [priceRound, storageKey]);

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
    // 同上：重建后的图表要重新贴，不然稀疏币切周期又变成满屏竖条
  }, [priceRound, storageKey]);

  // ---- 工具切换 ----
  useEffect(() => {
    dmRef.current?.setTool(tool);
  }, [tool]);

  /**
   * 图左上角那块持仓摘要：张数、开仓、标记、已盈亏，以及打到止损止盈各平出多少钱。
   * 数字全部由 pnlOf 现算 —— 和持仓卡、和交易所是同一个口径，多空两边也一样。
   */
  // 图上只算张数、均价、标记价和已盈亏 —— 止损止盈不画在图上（持仓卡里看得到）
  const positionViews = positions.map((p) => ({
    p,
    // 数据停更时别拿实时的价去配旧的持仓：那一行会变成「旧开仓 + 新价格」，
    // 看着就是个自相矛盾的数字。停更时整块退回快照自己的价。
    live: pnlOf(p, stale ? 0 : markPrice, multiplier),
  }));

  // 仓没了就把「确认平掉」收掉，别让人对着已经不在的数字点确认
  useEffect(() => {
    if (closing && !positions.some((x) => x.direction === closing)) setClosing(null);
  }, [positions, closing]);

  return (
    <>
      <div className="chart-tools">
        {research ? (
          <span className="dim" style={{ fontSize: 11 }}>研究台 · {interval} · 纯本地历史数据</span>
        ) : (
          <>
          <div className="seg">
            {intervals.map((i) => (
              <button key={i} className={i === interval ? 'on' : ''} onClick={() => onIntervalChange(i)}>{i}</button>
            ))}
          </div>
          <div className="tool-divider" />
          </>
        )}
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
        {!research && (<>
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
            // 先拷一份再删：selection() 给的是内部集合时，边遍历边删除会跳元素
            for (const id of [...dm.selection()]) dm.remove(id);
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
        </>)}
        <div className="spacer" style={{ flex: 1 }} />
        {bars.length > 0 && (
          <span className="dim" style={{ fontSize: 10.5 }} title="已经拿到的 K 线根数，以及最老那一根的时间">
            {backfilling ? '正在补历史 · ' : ''}{bars.length} 根 · 最早 {fmtDate(bars[0]!.time)}
          </span>
        )}
        {!research && <span className="dim" style={{ fontSize: 10.5 }}>画线自动存本地</span>}
      </div>

      <div className="chart-wrap">
        <div className="chart-host" ref={hostRef} />
        {/* 价格和右侧轴、档位带、持仓卡用同一个口径：冷门币跳到 0.00001 时 toFixed 不会写出两个数 */}
        {legend && (
          <div className="chart-badge">
            <span>O {legend.o == null ? '—' : fmtPrice(legend.o, priceRound)}</span>
            <span className="up">H {legend.h == null ? '—' : fmtPrice(legend.h, priceRound)}</span>
            <span className="down">L {legend.l == null ? '—' : fmtPrice(legend.l, priceRound)}</span>
            <span>C {fmtPrice(legend.c, priceRound)}</span>
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
            持仓数据停更 {Math.round(stale.ageMs / 1000)} 秒 · 图上的均价是旧快照
          </div>
        )}
        {positionViews.length > 0 && (
          <div className={'chart-pos' + (stale ? ' stale' : '')}>
            {positionViews.map(({ p, live }) => {
              const isLong = p.direction === 'long';
              const asking = closing === p.direction;
              return (
                <div key={p.direction} className={'cp-row ' + (isLong ? 'long' : 'short')}>
                  <div className="cp-head">
                    <span className="cp-dir">
                      {isLong ? '多' : '空'} {Math.abs(p.size)} 张 · {p.leverage > 0 ? `${p.leverage}x 逐仓` : '全仓'}
                    </span>
                    <span className={'cp-pnl ' + (live.pnl >= 0 ? 'up' : 'down')}>
                      {fmtMoney(live.pnl)}
                      {live.pct !== null && <span className="dim"> ({fmtPct(live.pct, 2)})</span>}
                    </span>
                  </div>
                  <div className="cp-mid">
                    <span>开仓 {fmtPrice(p.entryPrice, priceRound)}</span>
                    <span>标记 {fmtPrice(live.price, priceRound)}</span>
                    {p.liqPrice > 0 && <span className="warn">强平 {fmtPrice(p.liqPrice, priceRound)}</span>}
                  </div>

                  <div className="cp-acts">
                    {asking ? (
                      <>
                        <button
                          className="btn danger xs"
                          disabled={!canClose}
                          onClick={() => onClosePosition(p.contract, p.direction)}
                        >
                          确认平掉 {Math.abs(p.size)} 张
                        </button>
                        <button className="btn ghost xs" onClick={() => setClosing(null)}>算了</button>
                      </>
                    ) : (
                      <button
                        className="btn ghost xs"
                        disabled={!canClose}
                        title={canClose ? '按市价平掉这张仓（和持仓卡里是同一个接口）' : '先解锁交易'}
                        onClick={() => setClosing(p.direction)}
                      >
                        市价平
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {menu && (
          <div
            className="price-menu-scrim"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          >
            <div
              className="price-menu"
              style={{
                left: Math.min(menu.x, Math.max(0, (hostRef.current?.clientWidth ?? 400) - 200)),
                top: Math.min(menu.y, Math.max(0, (hostRef.current?.clientHeight ?? 300) - 250)),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="pm-head">
                <span className="pm-price">{fmtPrice(menu.price, priceRound)}</span>
                {menu.time !== null && <span className="dim">{fmtDate(menu.time)}</span>}
              </div>
              {([
                ['limit', '作为限价', !hasPosition ? '' : ''],
                ['stop', '作为止损价', ''],
                ['target', '作为止盈价', ''],
              ] as const).map(([what, label]) => (
                <button
                  key={what}
                  className="pm-item"
                  onClick={() => { pickRef.current(menu.price, what as PricePick); setMenu(null); }}
                >
                  <span>{label}</span>
                  <span className="pm-hint">{what === 'limit' ? '下单面板' : what === 'stop' ? '下单面板' : '下单面板'}</span>
                </button>
              ))}
              <div className="pm-sep" />
              {([
                ['posStop', '覆盖持仓止损'],
                ['posTarget', '覆盖持仓止盈'],
              ] as const).map(([what, label]) => (
                <button
                  key={what}
                  className="pm-item"
                  disabled={!hasPosition}
                  title={hasPosition ? '立即改这张仓的止损/止盈（会撤掉原来那张触发单）' : '这个合约上还没有持仓'
                  }
                  onClick={() => { pickRef.current(menu.price, what as PricePick); setMenu(null); }}
                >
                  <span>{label}</span>
                  <span className="pm-hint">{hasPosition ? '直接改仓' : '没有持仓'}</span>
                </button>
              ))}
              <div className="pm-foot">右键取价 · 点空白处关掉</div>
            </div>
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
