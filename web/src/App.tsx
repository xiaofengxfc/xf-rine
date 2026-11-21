import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  jget, jsend, setNotArmedHandler,
  type Account, type AppConfig, type Bar, type ContractInfo,
  type CloseResult, type LevelsResponse, type LiveTicker, type NewsDigest, type OpenOrder, type Position,
  type PrivateState, type PriceOrder, type Ticker, type WsMessage,
  type LocalDirInfo,
} from './lib/api.ts';
import { intervalSeconds, mergeNewer, mergeOlder } from './lib/candles.ts';
import { fmtPrice, guessPriceRound } from './lib/format.ts';
import { backfill } from './lib/backfill.ts';
import { wsUrl } from './lib/endpoint.ts';
import ChartPane, { type PricePick } from './components/ChartPane.tsx';
import ContractRail from './components/ContractRail.tsx';
import TopBar, { type View } from './components/TopBar.tsx';
import ResearchDesk from './components/ResearchDesk.tsx';
import AiTradingDesk from './components/AiTradingDesk.tsx';
import QuantDesk from './components/QuantDesk.tsx';
import LevelsStrip from './components/LevelsStrip.tsx';
import OrderTicket from './components/OrderTicket.tsx';
import PositionsCard from './components/PositionsCard.tsx';
import NewsCard from './components/NewsCard.tsx';
import AiCard from './components/AiCard.tsx';
import SettingsDialog from './components/SettingsDialog.tsx';

interface Toast { id: number; kind: 'ok' | 'err'; title: string; detail?: string }

/**
 * 一份行情快照，跟着「币种:周期」走。
 * 切币种时旧请求可能晚回来，只有 key 对得上才允许写进状态，
 * 否则图表、档位、下单面板会串成上一个币种的数据。
 */
interface MarketSnap {
  key: string;
  info: ContractInfo | null;
  bars: Bar[];
  levels: LevelsResponse | null;
  levelsError?: string | null;
}

const EMPTY_BARS: Bar[] = [];

const EMPTY_MARKET: MarketSnap = { key: '', info: null, bars: [], levels: null };

/** 往回要一页多少根。交易所一次最多给 1000，要满它就是一次往返拿双份 */
const OLDER_PAGE = 1000;
/** 右边界对齐一次取多少根。够盖住几分钟没收到推送的那一段，又不至于每次都拖一整页 */
const TAIL_PAGE = 300;
/**
 * 内存里最多留多少根。
 * 交易所每个周期只给约一万根，留两万接住它给的全部还有余量。
 * 这个数比交易所的上限大，所以正常补历史永远碰不到它。
 */
const MAX_BARS = 20000;

const PREFS_KEY = 'xf-rine:prefs';
const RAIL_COLLAPSED_KEY = 'xf-rine:rail-collapsed';
const DEFAULT_CONTRACT = 'BTC_USDT';
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

interface Prefs {
  contract: string;
  interval: string;
  /** 用可用余额的百分之几开仓（25 / 50 / 75 / 100） */
  posPct: number;
}

const DEFAULT_PREFS: Prefs = { contract: DEFAULT_CONTRACT, interval: '15m', posPct: 25 };

/**
 * 存下来的合约名还算不算数。
 *
 * 别用 [A-Z0-9_] 这种白名单：Gate 上有 牛逼_USDT、牛来_USDT 这类中文合约，
 * 从左边栏选中之后，存进去的偏好下次读不回来 —— 刷新一下就悄悄跳回 BTC，
 * 用户只会觉得「选的币丢了」。所以只挡明显不是合约名的东西：空白、控制字符、斜杠。
 */
function isContractName(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s.length >= 2 && s.length <= 40 && !/[\s/\\?#%]/.test(s);
}

/**
 * 记住上次在看什么：币种、周期、按多少比例开仓。
 * 刷新一次就跳回 BTC/15m/看多很烦，但这只是偏好，
 * 读坏了就当没存过，绝不能让页面因此起不来。
 */
function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    return {
      contract: isContractName(raw.contract) ? raw.contract : DEFAULT_PREFS.contract,
      interval: typeof raw.interval === 'string' && INTERVALS.includes(raw.interval) ? raw.interval : DEFAULT_PREFS.interval,

      posPct: typeof raw.posPct === 'number' && raw.posPct > 0 && raw.posPct <= 100 ? raw.posPct : DEFAULT_PREFS.posPct,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* 存不了就算了 */ }
}

let toastSeq = 1;

export default function App() {
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const prefs0 = useRef(readPrefs()).current;
  const [contract, setContract] = useState(prefs0.contract);
  const [interval, setInterval] = useState(prefs0.interval);
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [market, setMarket] = useState<MarketSnap>(EMPTY_MARKET);
  const [news, setNews] = useState<NewsDigest | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [priceOrders, setPriceOrders] = useState<PriceOrder[]>([]);
  /** 私有数据最后一次成功刷新的时刻，以及失败原因（失败时界面要直说，不能装作还是新的） */
  const [privateAt, setPrivateAt] = useState(0);
  const [privateErr, setPrivateErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  /** 令牌给轮询那类请求用：那些 effect 不该因为解锁状态变了就整条重建 */
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  /**
   * 服务端对这个令牌的核对结果。null = 还没问过。
   *
   * 令牌存在服务端内存里，服务重启或者在另一台设备上锁定过之后就没了，
   * 页面自己看不出来。每 3 秒的 /api/private-state 会带回来一次，照它落锁。
   * 结果和令牌一起记：解锁的那一瞬间，手上还留着上一次的旧结果，
   * 只比「有没有效」会把刚解锁的会话立刻按回去。
   */
  const [armCheck, setArmCheck] = useState<{ token: string; ok: boolean } | null>(null);
  const [wsAlive, setWsAlive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 手机上左栏是抽屉：点顶栏的「合约」打开，选完自动收 */
  const [railOpen, setRailOpen] = useState(false);
  /** 桌面端收起币种栏时保留用户选择 */
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try { return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(RAIL_COLLAPSED_KEY, railCollapsed ? '1' : '0'); } catch { /* 存不了就算了 */ }
  }, [railCollapsed]);
  /**
   * 两个页面：日内台（看盘下单）和研究台（本地数据算关键位）。
   *
   * 研究台不依赖交易所，也不碰仓位；交易台那边的一切状态在切换时都留着，
   * 切回来还是原来那个币种、那个周期。
   */
  const [view, setViewState] = useState<View>(() => {
    const h = window.location.hash;
    return h === '#research' ? 'research' : h === '#ai' ? 'ai' : h === '#quant' ? 'quant' : 'desk';
  });
  /**
   * 研究台第一次打开之后就一直挂着，切回日内台只是藏起来。
   *
   * 卸掉再挂会重算一遍单品种分析和扫描结果 —— 用户在两页之间来回看一眼，
   * 回来发现表空了、又得等一遍，正是「两个台不兼容」的那种感觉。
   */
  const [researchMounted, setResearchMounted] = useState(view === 'research');
  /** AI 交易台也一样：切走再切回来，决策流和表单不该重新拉一遍 */
  const [aiMounted, setAiMounted] = useState(view === 'ai');
  const [quantMounted, setQuantMounted] = useState(view === 'quant');

  /**
   * 切页面时把 hash 一起改掉。
   *
   * 这不只是好看：桌面端和手机端都能把「研究台」存成书签 / 主屏图标，
   * 打开就是那一页；调样式时也能直接开 #research 核对，不用每次都点一下。
   */
  const setView = useCallback((v: View) => {
    setViewState(v);
    if (v === 'research') setResearchMounted(true);
    if (v === 'ai') setAiMounted(true);
    if (v === 'quant') setQuantMounted(true);
    try {
      const url = v === 'research' ? '#research'
        : v === 'ai' ? '#ai'
          : v === 'quant' ? '#quant'
            : window.location.pathname + window.location.search;
      window.history.replaceState(null, '', url);
    } catch { /* 某些 WebView 不让改，忽略 */ }
  }, []);
  const [manualLevels, setManualLevels] = useState<number[]>([]);
  /** 研究台读取的本地 Parquet 数据目录。日内台始终使用交易所行情。 */
  const [local, setLocal] = useState<LocalDirInfo | null>(null);
  /** 研究台本地数据的品种和周期，周期代号来自文件名（D1 / H1 / 15min…）。 */
  const [localSym, setLocalSym] = useState('');
  const [localTf, setLocalTf] = useState('D1');
  /**
   * 下单面板的三个价提在这一层。
   *
   * 图上右键取价要写进这三个框，面板自己拿着状态图表就够不着。提上来之后
   * 右键 → 价格进框 → 下面那张多空盈亏表立刻按这个价重算，是一条直线。
   */
  const [limitStr, setLimitStr] = useState('');
  const [stopStr, setStopStr] = useState('');
  const [targetStr, setTargetStr] = useState('');
  const [priceMode, setPriceMode] = useState<'market' | 'limit'>('limit');
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [posPct, setPosPct] = useState(prefs0.posPct);
  /** 限价单带止盈止损下的单：等它成交、持仓出现，再把保护补上 */
  const [protectQueue, setProtectQueue] = useState<{
    id: number;
    contract: string;
    direction: 'long' | 'short';
    stop: number;
    target: number;
    /** 下单时间 */
    at: number;
    /** 入场委托号。回踩单能挂几个小时，靠它判断入场单还在不在 */
    orderId?: string;
    /** 第一次发现委托不见了的时间，用来留宽限 */
    missingSince?: number;
  }[]>([]);
  const protectSeq = useRef(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number>(0);
  const lastBarRef = useRef<{ at: number; closed: boolean }>({ at: 0, closed: true });
  /** 行情请求序号。切币种时让晚回来的旧请求作废。 */
  const marketSeqRef = useRef(0);
  /**
   * 最近看过的几套「币种:周期」。
   *
   * 切币种要等合约参数、K 线和档位三份回包，快的半秒、慢的几秒 —— 每次切都空白等着，
   * 手一快就是「点了没反应」。切回刚看过的那个直接拿缓存顶着，再去后台刷新；
   * 只留 4 套，免得两万根 K 线攒成几百兆。
   */
  const marketCacheRef = useRef(new Map<string, { info: ContractInfo; bars: Bar[]; levels: LevelsResponse | null; levelsError?: string | null }>());
  /** 已经到交易所能给的最早一根 */
  const noMoreOlderRef = useRef(false);
  /** 交易所给的历史就这么多，图上要有个说明，不然拖到头像是在卡死 */
  const [historyEnd, setHistoryEnd] = useState(false);
  /** 后台正在往左补历史。界面上要说一句，不然看不出还在加载 */
  const [backfilling, setBackfilling] = useState(false);
  /** 正在补哪个 key。同一个 key 不重复开一轮，换 key 就让旧的那轮自己停 */
  const pumpingKeyRef = useRef('');
  /** 补页的轮次号。换 key 时递增，旧的循环据此停下并且不再动界面 */
  const pumpGenRef = useRef(0);
  /** 已经自动补过一轮的 key */
  const pumpedKeyRef = useRef('');
  /** 「上游没给新页」自动重试了几次。留个上限，别一直空转 */
  const nopageRetryRef = useRef(0);
  const marketRef = useRef(market);
  useEffect(() => { marketRef.current = market; }, [market]);
  const newsSeqRef = useRef(0);
  /** 私有数据的请求序号：轮询和手动刷新撞在一起时，只认最后发出去的那一份 */
  const privateSeqRef = useRef(0);
  /**
   * ws 推上来的行情。每秒好几帧，每帧都 setState 会把整棵树重渲染好几遍，
   * 所以先攒在 ref 里，300ms 一次刷进状态 —— 肉眼看是连续的，React 也扛得住。
   */
  const pendingTickerRef = useRef<LiveTicker | null>(null);

  // 安卓返回键（见 lib/native.ts）：先收浮层，没人接手才退出程序。
  // 手机上没 Esc，这是唯一能「关掉这一层」的顺手动作。
  useEffect(() => {
    const onBack = (e: Event) => {
      if (settingsOpen) { e.preventDefault(); setSettingsOpen(false); return; }
      if (railOpen) { e.preventDefault(); setRailOpen(false); return; }
      // 研究台不是浮层，但在手机上按返回直接退出程序太粗：先退回日内台，再按一次才退出
      if (view === 'research' || view === 'ai' || view === 'quant') { e.preventDefault(); setView('desk'); }
    };
    window.addEventListener('xf-back', onBack);
    return () => window.removeEventListener('xf-back', onBack);
  }, [settingsOpen, railOpen, view, setView]);

  // 抽屉开着的时候按 Esc 收起来。手机上没键盘，但接外接键盘的平板有。
  useEffect(() => {
    if (!railOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRailOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [railOpen]);

  // 抽屉是窄屏才有的形态。窗口从窄拖宽之后它已经不在屏幕上了，
  // 状态得跟着收掉：否则那块遮罩会留在 DOM 里当网格子元素，把整页布局撑歪。
  useEffect(() => {
    if (!railOpen) return;
    const mq = window.matchMedia('(max-width: 1180px)');
    const onChange = () => { if (!mq.matches) setRailOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [railOpen]);

  /** 研究台本地数据的品种/周期。周期不在这个品种里就退回它有的第一个 */
  const localPick = useMemo(() => {
    const inst = local?.instruments.find((i) => i.symbol === localSym);
    if (!inst) return null;
    const tf = inst.timeframes.includes(localTf) ? localTf : (inst.timeframes[0] ?? 'D1');
    return { symbol: inst.symbol, tf };
  }, [local, localSym, localTf]);

  /**
   * 「当前在看什么」的标识。
   *
   * 日内台只展示交易所行情，研究台使用独立的分析数据，不会切换日内行情源。
   */
  const marketKey = `${contract}:${interval}`;

  // 只有归属当前币种和周期的数据才交给界面。切币那一帧旧数据还在 state 里，
  // 这一层直接挡掉，图表和右侧面板就不可能显示上一个币种的价格。
  const fresh = market.key === marketKey;
  const info = fresh ? market.info : null;
  const bars = fresh ? market.bars : EMPTY_BARS;
  const levels = fresh ? market.levels : null;
  const levelsError = fresh ? market.levelsError : null;

  const push = useCallback((kind: 'ok' | 'err', title: string, detail?: string) => {
    const id = toastSeq++;
    setToasts((t) => [...t.slice(-4), { id, kind, title, detail }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 9000 : 5000);
  }, []);

  useLayoutEffect(() => {
    const root = appRootRef.current;
    const topbar = root?.querySelector<HTMLElement>('.topbar');
    if (!root || !topbar) return;

    const updateTopbarHeight = () => {
      root.style.setProperty('--mobile-topbar-height', `${topbar.getBoundingClientRect().height}px`);
    };
    updateTopbarHeight();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateTopbarHeight);
      return () => window.removeEventListener('resize', updateTopbarHeight);
    }

    const observer = new ResizeObserver(updateTopbarHeight);
    observer.observe(topbar);
    return () => observer.disconnect();
  }, []);

  /**
   * 这份数据还归不归当前这一屏。
   *
   * 切币种的那几帧里，图上的旧数据还在，它的视口回调会来催「再要一页」。
   */
  const isCurrentMarket = useCallback((key: string) => {
    return key === `${contract}:${interval}`;
  }, [contract, interval]);

  /**
   * 把能拿的历史一路补到底。
   *
   * 拖动只是再催一次：正在补的时候直接返回，不重复开一轮。
   * 补到交易所到头或者切了币种为止，中间不停 ——
   * 以前一页一页等拖动事件催，用户不动历史就停在原地。
   */
  const backfillOlder = useCallback(async () => {
    const key = marketRef.current.key;
    if (!key || marketRef.current.bars.length === 0) return;
    if (!isCurrentMarket(key)) return;
    if (noMoreOlderRef.current || pumpingKeyRef.current === key) return;
    const gen = ++pumpGenRef.current;
    pumpingKeyRef.current = key;
    const [name, tf] = key.split(':') as [string, string];
    // 换了币种或者已经开了新的一轮：这一轮立刻收手，也不再写界面
    const stale = () => pumpGenRef.current !== gen || marketRef.current.key !== key;
    let failures = 0;
    setBackfilling(true);
    try {
      const r = await backfill({
        bars: marketRef.current.bars,
        maxBars: MAX_BARS,
        shouldStop: stale,
        onError: () => { failures += 1; },
        fetchPage: async (before) => {
          const page = await jget<{ bars: Bar[]; exhausted?: boolean }>(
            `/api/candles?contract=${name}&interval=${tf}&limit=${OLDER_PAGE}&before=${before}`,
          );
          // 到头只认服务端说的 exhausted：交易所偶尔少给几根，不满一页不代表没有
          return { bars: page.bars, exhausted: page.exhausted === true };
        },
        onPage: (next) => {
          if (stale()) return;
          setMarket((prev) => {
            if (prev.key !== key) return prev;
            // 补页这一秒里 WebSocket 可能推来新的一根。整份替换会把它丢掉，
            // 所以只把更早的那一段并到前面，新数据还是用 prev 的
            const m = mergeOlder(prev.bars, next, MAX_BARS);
            return m.bars === prev.bars ? prev : { ...prev, bars: m.bars };
          });
        },
      });
      if (stale()) return;
      // 真拿到东西了就把重试计数清掉，下次抖动还有三次机会
      if (r.stopped === 'exhausted' || r.stopped === 'full' || r.pages > 0) nopageRetryRef.current = 0;
      if (r.stopped === 'exhausted') {
        // 不弹提示：图上到了最左边会写一行，工具栏上也一直写着根数和最早那一天
        noMoreOlderRef.current = true;
        setHistoryEnd(true);
      } else if (r.stopped === 'full') {
        noMoreOlderRef.current = true;
        push('ok', `已加载 ${r.bars.length} 根 K 线`, `本地上限 ${MAX_BARS} 根。要看更早的行情，换更大的周期。`);
      } else if (r.stopped === 'error' && failures > 0) {
        // 不算到头：切回来或者往回拖一下会重新拉
        push('err', '历史 K 线没拉到', '服务端或交易所没有响应。往回拖一下会重新拉。');
      } else if (r.stopped === 'nopage' || r.stopped === 'pagelimit') {
        /**
         * 上游这一会儿一直给重复的页（服务端连续失败会歇十秒，冷却期间回的也是空页），
         * 或者一轮补到了页数上限。
         *
         * 这两种以前什么都不做：工具栏上「正在补历史」一消失就再没动静，
         * 除了用户自己拖一下视口，这条时间轴就停在那儿了 —— 正是要修的「一次抖动就不再加载」。
         * 现在过几秒自己再来一轮，连着三次都没进展才提示。
         */
        if (nopageRetryRef.current < 3) {
          nopageRetryRef.current += 1;
          const wait = 4000 * nopageRetryRef.current;
          const gen0 = pumpGenRef.current;
          window.setTimeout(() => {
            if (pumpGenRef.current !== gen0 || marketRef.current.key !== key) return;
            void backfillOlder();
          }, wait);
        } else {
          nopageRetryRef.current = 0;
          push('err', '历史 K 线拉不动了', '交易所那头连着几次没给新的页。往回拖一下会再试。');
        }
      }
    } finally {
      /**
       * 这一轮不管是怎么收的（补完、出错、还是切了币种被 stale 提前收手），
       * 都要把「正在补历史」关掉。
       *
       * 以前只有还是同一轮才关。可切换币种时新一代已经开跑，条件不成立 ——
       * 那一页就一直挂着「正在补历史」，直到下一次真补完为止。
       * 关掉是无害的：新一代开跑时自己会再 setBackfilling(true)。
       */
      if (pumpGenRef.current === gen) pumpingKeyRef.current = '';
      setBackfilling(false);
    }
  }, [push, isCurrentMarket]);

  /** 图表催历史。写成稳定的回调，否则每次渲染都会重新订阅视口 */
  const needOlder = useCallback(() => { void backfillOlder(); }, [backfillOlder]);

  /**
   * 把右边界的缺口补齐。
   *
   * WebSocket 掉线、代理抖一下、几分钟没收到推送，中间就少了几根 —— 而收到新 K 线时
   * 只认「比图上最后一根新」，缺的那段自己永远回不来，看着就是 K 线残了一块。
   * 这里按整页重取尾部（服务端有缓存，正常几十毫秒），按时间合并：缺几根补几根，
   * 最后一根还在走的时候顺手覆盖成最新的。
   */
  const resyncTail = useCallback(async () => {
    const key = marketRef.current.key;
    if (!key || marketRef.current.bars.length === 0) return;
    if (!isCurrentMarket(key)) return;
    const [name, tf] = key.split(':') as [string, string];
    try {
      const page = await jget<{ bars: Bar[] }>(`/api/candles?contract=${name}&interval=${tf}&limit=${TAIL_PAGE}`);
      if (marketRef.current.key !== key) return;
      setMarket((prev) => {
        if (prev.key !== key) return prev;
        const m = mergeNewer(prev.bars, page.bars, MAX_BARS);
        return m.added === 0 && m.patched === 0 ? prev : { ...prev, bars: m.bars };
      });
    } catch { /* 补不回来不影响看盘，下一轮再看 */ }
  }, [isCurrentMarket]);

  /**
   * 尾部看门狗：最后一根落后超过 3 个周期就补一次。
   *
   * 推送正常时这里一次请求都不会发（BTC 这种每秒都在推）；只有推送真停了才动 ——
   * 比如 Gate 断过、这枚币很久没成交、或者订阅没接上。
   */
  useEffect(() => {
    const step = intervalSeconds(interval);
    const t = window.setInterval(() => {
      const list = marketRef.current.bars;
      if (list.length === 0) return;
      if (Date.now() / 1000 - list[list.length - 1]!.time > step * 3) void resyncTail();
    }, 15_000);
    return () => window.clearInterval(t);
  }, [interval, resyncTail]);

  // ---------- 只读数据 ----------

  const loadConfig = useCallback(async () => {
    try { setConfig(await jget<AppConfig>('/api/config')); } catch { /* 静默 */ }
  }, []);

  const loadTickers = useCallback(async () => {
    try {
      const list = await jget<Ticker[]>('/api/tickers');
      setTickers(list);
      // 上次存的币种可能已经下架，别让页面一直卡在一个不存在的合约上
      if (list.length > 0) setContract((c) => (list.some((t) => t.contract === c) ? c : DEFAULT_CONTRACT));
    } catch { /* 静默 */ }
  }, []);

  // 选过的东西记下来，刷新后接着看同一个
  useEffect(() => { savePrefs({ contract, interval, posPct }); }, [contract, interval, posPct]);

  /** 拉一次目录状态：记住了哪个目录、里面有哪些品种周期 */
  const loadLocal = useCallback(async () => {
    try {
      const d = await jget<LocalDirInfo>('/api/data/dir');
      // 整个对象留着：品种、文件数、周期显示名、读不出来的原因，两个页面都要用
      setLocal(d);
      if (!d.dir) return;
      // 记住的品种还在就留着，不在就跳到第一个
      setLocalSym((cur) => {
        if (d.instruments.some((i) => i.symbol === cur)) return cur;
        return d.instruments[0]?.symbol ?? '';
      });
    } catch { /* 静默：本地数据是可选项，读不到不影响看盘 */ }
  }, []);

  /**
   * 手机上选不了目录：那个接口只认本机回环地址（它是「读你硬盘」的入口）。
   * 与其让用户点了之后收到 403，不如一开始就说清楚只能在电脑上选。
   *
   * 判断以服务端说的为准（/config 的 local 字段），不再看 window.location.hostname：
   * 桌面壳里页面可能是 file:// 或 0.0.0.0，局域网访问时又是个 192.168.x.x ——
   * 那个判断和请求真实的来源对不上，按钮会一直显示「只能在电脑上选」。
   * config 还没回来时先按可用处理：多一个按钮好过把一个能用的功能藏起来，
   * 真不能用时服务端会回 403，理由照原样显示出来。
   */
  const canPickLocal = config ? config.local !== false : true;

  /**
   * 顶栏那个绿点要知道 AI 开着没有。
   *
   * 这一份只管「有没有开」；真正的策略和决策流由 AI 交易页自己拉。
   * 在这里再存一份完整策略，两边就变成两份可能不同的真相。
   */
  const [aiOn, setAiOn] = useState(false);
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const s = await jget<{ status: { enabled: boolean } }>('/api/ai/strategy');
        if (alive) setAiOn(Boolean(s.status?.enabled));
      } catch { /* 老服务端没有这个接口：当作没开 */ }
    };
    void pull();
    const t = window.setInterval(() => void pull(), 20_000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);


  /**
   * 选 / 换一个本地数据目录。
   *
   * 服务端只接受本机调用（那是读硬盘的接口），失败时把原因原样说出来 ——
   * 手机上点这个按钮看到「只允许本机访问」，比看到一个空列表有用。
   */
  const pickLocalDir = useCallback(async (dir: string): Promise<LocalDirInfo | null> => {
    try {
      const r = await jsend<LocalDirInfo & { ok: boolean }>('POST', '/api/data/dir', { dir });
      const next: LocalDirInfo = { ...r, exists: true, count: r.count ?? r.instruments.length };
      setLocal(next);
      setLocalSym(r.instruments[0]?.symbol ?? '');
      if (r.instruments.length === 0) {
        push('err', '这个目录里没有认得的 K 线文件', r.warning ?? '文件名要写成「品种_周期.parquet」');
      } else {
        push('ok', '数据目录已载入', r.instruments.length + ' 个品种 · ' + r.files + ' 个文件');
      }
      return next;
    } catch (e) {
      push('err', '这个目录用不了', (e as Error).message);
      return null;
    }
  }, [push]);

  const loadMarket = useCallback(async (name: string, tf: string) => {
    const key = `${name}:${tf}`;
    const seq = ++marketSeqRef.current;
    noMoreOlderRef.current = false;
    setHistoryEnd(false);
    // 缓存里有就先画出来：不空白等那一拍，再去刷新（刷新回来的数照旧覆盖）
    const cached = marketCacheRef.current.get(key) ?? null;
    if (cached) setMarket({ key, ...cached });
    setLoading(!cached);

    try {
      const levelsPromise = jget<LevelsResponse>(`/api/levels?contract=${name}&interval=${tf}&limit=500`)
        .then((levels) => ({ levels, error: null as string | null }))
        .catch((e: unknown) => ({ levels: null, error: (e as Error).message || '关键位暂不可用' }));
      const [c, k, levelsResult] = await Promise.all([
        jget<ContractInfo>(`/api/contracts/${name}`),
        // 首屏直接要满一页：一页一千根，剩下的交给后台补
        jget<{ bars: Bar[] }>(`/api/candles?contract=${name}&interval=${tf}&limit=${OLDER_PAGE}`),
        levelsPromise,
      ]);
      // 独立行情后端可能暂时没有关键位引擎。失败时保留已经加载的图表数据。
      const { levels: lv, error: levelsError } = levelsResult;
      // 期间又切过币种，这份数据已经不是当前要看的东西了
      const cache = marketCacheRef.current;
      cache.delete(key);
      cache.set(key, { info: c, bars: k.bars, levels: lv, levelsError });
      if (cache.size > 4) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      if (seq !== marketSeqRef.current) return;
      setMarket({ key, info: c, bars: k.bars, levels: lv, levelsError });
    } catch (e) {
      if (seq === marketSeqRef.current) push('err', '行情加载失败', (e as Error).message);
    } finally {
      if (seq === marketSeqRef.current) setLoading(false);
    }
  }, [push]);

  const loadLevelsOnly = useCallback(async (name: string, tf: string) => {
    const key = `${name}:${tf}`;
    try {
      const lv = await jget<LevelsResponse>(`/api/levels?contract=${name}&interval=${tf}&limit=500`);
      setMarket((prev) => (prev.key === key ? { ...prev, levels: lv, levelsError: null } : prev));
    } catch (e) {
      setMarket((prev) => (prev.key === key
        ? { ...prev, levelsError: (e as Error).message || '关键位暂不可用' }
        : prev));
    }
  }, []);

  const loadNews = useCallback(async (name: string) => {
    const seq = ++newsSeqRef.current;
    setNewsLoading(true);
    try {
      const d = await jget<NewsDigest>(`/api/news?contract=${name}&limit=6`);
      if (seq === newsSeqRef.current) setNews(d);
    } catch { /* 新闻抓不到不影响看盘 */ } finally {
      if (seq === newsSeqRef.current) setNewsLoading(false);
    }
  }, []);


  const queueProtect = useCallback((p: { contract: string; direction: 'long' | 'short'; stop: number; target: number; orderId: string }) => {
    setProtectQueue((list) => [...list, { ...p, id: ++protectSeq.current, at: Date.now() }]);
  }, []);

  const loadPrivate = useCallback(async () => {
    if (!config) return;
    if (!config.keys.configured) {
      setAccount(null);
      setAccountError(`当前${config.envLabel}未配置 API Key`);
      return;
    }
    const seq = ++privateSeqRef.current;
    try {
      // 一次取全：账户、持仓、委托、触发单。单项权限不足时，服务端仍返回其余成功字段。
      const t = tokenRef.current;
      const s = await jget<PrivateState>('/api/private-state', {
        headers: t ? { 'x-arm-token': t } : undefined,
      });
      if (seq !== privateSeqRef.current) return;
      if (s.account) { setAccount(s.account); setAccountError(null); }
      else if (s.errors?.account) setAccountError(s.errors.account);
      if (s.positions) setPositions(s.positions.filter((p) => Math.abs(p.size) > 0));
      if (s.orders) setOrders(s.orders);
      if (s.priceOrders) setPriceOrders(s.priceOrders);
      if (t) setArmCheck({ token: t, ok: s.armed === true });
      const labels = { account: '账户', positions: '持仓', orders: '委托', priceOrders: '保护单' };
      const errors = Object.entries(s.errors ?? {}).map(([key, detail]) =>
        `${labels[key as keyof typeof labels] ?? key}：${detail}`,
      );
      if (errors.length) setPrivateErr(errors.join(' · '));
      else { setPrivateAt(Date.now()); setPrivateErr(null); }
    } catch (e) {
      // 汇总接口或网络异常时，仍单独取账户：可读余额不应被其他私有接口故障遮住。
      if (seq !== privateSeqRef.current) return;
      const message = (e as Error).message || '刷新失败';
      setPrivateErr(message);
      try {
        const a = await jget<Account>('/api/account');
        if (seq !== privateSeqRef.current) return;
        setAccount(a);
        setAccountError(null);
      } catch (accountFailure) {
        if (seq !== privateSeqRef.current) return;
        setAccountError((accountFailure as Error).message || message);
      }
    }
  }, [config?.envLabel, config?.keys.configured]);

  /**
   * 图上直接平仓。以前只有持仓卡里有这个动作，手机上要滑到图表下面很远才够得着，
   * 站在一张亏着的仓前面却按不到平仓。接口和持仓卡用的是同一个，逻辑不另写一份。
   */
  const closeFromChart = useCallback(async (name: string, direction: 'long' | 'short') => {
    if (!token) return;
    try {
      const r = await jsend<CloseResult>('POST', '/api/close-position', { contract: name, direction }, token);
      const cleaned = [
        r.canceled.orders.length ? '撤掉委托 ' + r.canceled.orders.length + ' 张' : '',
        r.canceled.triggers.length ? '撤掉触发单 ' + r.canceled.triggers.length + ' 张' : '',
        ...r.canceled.errors,
      ].filter(Boolean).join(' · ');
      push('ok', '市价平仓已提交',
        name + ' ' + (direction === 'long' ? '多' : '空') + '头' + (cleaned ? ' · ' + cleaned : ' · 没有挂着的委托要撤'));
      void loadPrivate();
    } catch (e) {
      push('err', '平仓失败', (e as Error).message);
    }
  }, [token, push, loadPrivate]);

  /**
   * 把右键取到的价直接挂到当前持仓上。
   *
   * 只改点了的那一边，另一边保持原样：/api/bracket 是覆盖语义（先撤掉这一边已有的
   * 触发单，再挂你填的价）。所以另一边必须从「现在挂着的触发单」里读回来一起传，
   * 否则「右键改止损」会顺手把止盈撤掉 —— 用户以为只动了一边，其实裸了一边。
   *
   * 价格顺序就是语义：这一边的触发单里，多头止损在标记价下方、止盈在上方，空头反过来。
   */
  const applyToPosition = useCallback(async (kind: 'stop' | 'target', price: number) => {
    if (!token) { push('err', '还没解锁交易', '先点右上角「解锁交易」'); return; }
    const pos = positions.find((p) => p.contract === contract);
    if (!pos) { push('err', '这个合约上没有持仓', contract); return; }
    // 这一边现有的触发单按价格在多空之间分：多头止损在下、止盈在上，空头反过来。
    // 价格顺序就是语义 —— 交易所的触发单里没有「这是止损」这个字段。
    const mine = priceOrders.filter((o) => o.contract === contract && o.direction === pos.direction);
    const below = mine.filter((o) => o.triggerPrice < pos.markPrice).map((o) => o.triggerPrice);
    const above = mine.filter((o) => o.triggerPrice > pos.markPrice).map((o) => o.triggerPrice);
    const stopList = pos.direction === 'long' ? below : above;
    const targetList = pos.direction === 'long' ? above : below;
    /** 同一侧可能挂着不止一张，取离现价最近的那张（也就是真正在护仓的那张） */
    const nearest = (xs: number[]) => xs.reduce((a, b) => (Math.abs(b - pos.markPrice) < Math.abs(a - pos.markPrice) ? b : a), 0);
    const stopNow = kind === 'stop' ? price : nearest(stopList);
    const targetNow = kind === 'target' ? price : nearest(targetList);
    try {
      await jsend('POST', '/api/bracket', {
        contract, direction: pos.direction, stop: stopNow, target: targetNow,
      }, token);
      const round = pos.contract === contract ? roundMap.get(contract) ?? 0.1 : 0.1;
      push('ok', (kind === 'stop' ? '止损' : '止盈') + '已改成 ' + fmtPrice(price, round),
        pos.direction === 'long' ? '多头 · ' + contract : '空头 · ' + contract);
      void loadPrivate();
    } catch (e) {
      push('err', '改止损止盈失败', (e as Error).message);
    }
    // priceRound 只用来写提示文案，不放进依赖：它定义在这段代码下面，
    // 而且换精度不该让这个回调重新生成一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, push, positions, priceOrders, contract, loadPrivate]);

  /**
   * 右键取价：图上的价 -> 下单面板 / 当前持仓的止损止盈。
   *
   * 前三个就地写进面板，规则是「只填这一格、不动别的」：
   *   - 「作为限价」顺带把面板切到限价，否则填了价还是按市价发单，填了等于没填；
   *   - 止损和止盈各管各的框 —— 右键两次就能把两边都填上，
   *     换成「覆盖另一个框」会让人莫名其妙丢掉刚填的那个数。
   * 后两个直接改仓，见 applyToPosition。
   */
  const pickPrice = useCallback((price: number, what: PricePick) => {
    if (!(price > 0)) return;
    const s = String(Number(price.toFixed(10)));
    if (what === 'limit') { setLimitStr(s); setPriceMode('limit'); }
    else if (what === 'stop') setStopStr(s);
    else if (what === 'target') setTargetStr(s);
    else void applyToPosition(what === 'posStop' ? 'stop' : 'target', price);
  }, [applyToPosition]);

  /** 换合约时把三个价清空。面板把自己清不掉 —— 状态在这一层 */
  const resetTicketPrices = useCallback(() => {
    setLimitStr('');
    setStopStr('');
    setTargetStr('');
  }, []);

  // 首屏问一次本地目录：上次选过的目录下次打开还在，不用每次都重选
  useEffect(() => { void loadLocal(); }, [loadLocal]);

  useEffect(() => { void loadConfig(); void loadTickers(); }, [loadConfig, loadTickers]);
  useEffect(() => {
    void loadMarket(contract, interval);
  }, [contract, interval, loadMarket]);

  /**
   * 首屏数据一落地就补历史，不等用户拖动。
   * 图表的视口变化订阅挂在首次画完之后，那次订阅看不到开局的视口，所以不能靠它催。
   */
  useEffect(() => {
    if (!fresh || market.bars.length === 0) return;
    if (pumpedKeyRef.current === marketKey) return;
    pumpedKeyRef.current = marketKey;
    void backfillOlder();
  }, [fresh, marketKey, market.bars.length, backfillOlder]);

  useEffect(() => {
    const t = window.setInterval(() => void loadTickers(), 12_000);
    return () => window.clearInterval(t);
  }, [loadTickers]);

  useEffect(() => {
    void loadPrivate();
    // 持仓的已盈亏、挂单、止损止盈都跟着这一份走。3 秒一次：
    // 慢一档就能看着盘面变了半分钟，卡片上的盈亏还在原处。
    const t = window.setInterval(() => void loadPrivate(), 3_000);
    return () => window.clearInterval(t);
  }, [loadPrivate]);

  // 上一次没取到就快点再试一次，不用干等下一个 3 秒
  useEffect(() => {
    if (!privateErr) return;
    const t = window.setTimeout(() => void loadPrivate(), 1_200);
    return () => window.clearTimeout(t);
  }, [privateErr, privateAt, loadPrivate]);

  // 切回这个标签页、或者窗口重新获得焦点时立刻刷一次：
  // 浏览器在后台会压制定时器，回来时先对一次账，别让人对着几分前的仓做决定。
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      void loadPrivate();
      // 后台标签页的定时器会被压制，回来时把 K 线的尾巴也对一次
      void resyncTail();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [loadPrivate, resyncTail]);

  // ws 的行情帧攒够了再写进状态
  useEffect(() => {
    const t = window.setInterval(() => {
      const p = pendingTickerRef.current;
      if (!p) return;
      pendingTickerRef.current = null;
      setTickers((prev) => {
        const i = prev.findIndex((x) => x.contract === p.contract);
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = {
          ...next[i]!,
          last: p.last,
          mark: p.mark,
          change24h: p.change24h,
          fundingRate: p.fundingRate,
          volume24hUsd: p.volume24hUsd,
        };
        return next;
      });
    }, 300);
    return () => window.clearInterval(t);
  }, []);

  /**
   * 限价单成交之后才挂得上保护。持仓一出现就补挂一次。
   *
   * 过期规则原来是写死的 30 分钟，那在「回踩挂单」下是错的：入场价挂在支撑上沿，
   * 等两三个小时才成交很正常，队列早被丢掉，成交那一刻没人补挂 —— 看着有保护，其实是裸仓。
   * 所以改成跟着委托走：委托还在就一直等，持仓出现就挂，委托消失（撤了 / 过期了）才收尾。
   */
  useEffect(() => {
    if (!armed || !token || protectQueue.length === 0) return;
    const now = Date.now();
    /** 委托刚消失、持仓还没刷出来的那一下，留两分钟再看一眼 */
    const GRACE = 2 * 60_000;
    /** 兜底：一条记录最多活 24 小时 */
    const MAX_AGE = 24 * 3600_000;
    const keep: typeof protectQueue = [];
    const fire: typeof protectQueue = [];
    let changed = false;
    for (const q of protectQueue) {
      const pos = positions.find((p) => p.contract === q.contract && p.direction === q.direction && p.size > 0) ?? null;
      if (pos) {
        changed = true;
        // 止损是按挂单价填的。真成交价离它太远时，这个止损可能已经站到仓位的另一边 ——
        // 那样的触发单一挂上就成交，等于市价平仓。宁可先不挂，说清楚让人重算。
        const wrong = q.stop > 0 && (q.direction === 'long' ? q.stop >= pos.entryPrice : q.stop <= pos.entryPrice);
        if (wrong) {
          push(
            'err',
            '这套止损已经站错边了，没有补挂',
            q.contract + ' 成交价越过了填的止损。到持仓卡里「设止损止盈」按真实成本重填一遍。',
          );
          continue;
        }
        fire.push(q);
        continue;
      }
      if (now - q.at > MAX_AGE) { changed = true; continue; }
      // 没有委托号（老记录）就退回原来的规则：半小时内还等，之后作废
      if (!q.orderId) {
        if (now - q.at > 30 * 60_000) { changed = true; continue; }
        keep.push(q);
        continue;
      }
      if (orders.some((o) => o.id === q.orderId)) { keep.push(q); continue; }
      // 委托不在了、也还没见到持仓：先记一笔，给持仓刷新留宽限
      if (!q.missingSince) { keep.push({ ...q, missingSince: now }); changed = true; continue; }
      if (now - q.missingSince < GRACE) { keep.push(q); continue; }
      // 撤单或者过期了，这条不用再补
      changed = true;
    }
    if (changed) setProtectQueue(keep);
    for (const q of fire) {
      // 这一边已经有保护单了就别覆盖用户后来手动挂的那套
      if (priceOrders.some((o) => o.contract === q.contract && o.direction === q.direction)) continue;
      void jsend('POST', '/api/bracket', { contract: q.contract, direction: q.direction, stop: q.stop, target: q.target }, token)
        .then(() => { push('ok', '保护单已补挂', `${q.contract} · ${q.direction === 'long' ? '多' : '空'}`); void loadPrivate(); })
        .catch((e) => push('err', '补挂保护失败', (e as Error).message));
    }
  }, [armed, token, positions, priceOrders, orders, protectQueue, push, loadPrivate]);

  useEffect(() => {
    void loadNews(contract);
    // 服务端缓存 12 分钟，这里 5 分钟问一次，命中缓存就是几毫秒的事
    const t = window.setInterval(() => void loadNews(contract), 5 * 60_000);
    return () => window.clearInterval(t);
  }, [contract, loadNews]);

  // ---------- 行情 WebSocket ----------

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      // 地址和口令都由 endpoint 决定：浏览器同源，手机端连接本机或电脑服务端
      const ws = new WebSocket(wsUrl('/ws'));
      wsRef.current = ws;

      ws.onopen = () => {
        setWsAlive(true);
        reconnectRef.current = 0;
        ws.send(JSON.stringify({ type: 'subscribe', contract, interval }));
        // 断开这段时间图上是缺的，连上先按时间补一次，别让缺口一直留着
        void resyncTail();
      };

      ws.onmessage = (ev) => {
        let msg: WsMessage;
        try { msg = JSON.parse(ev.data) as WsMessage; } catch { return; }
        // 最新价、标记价、24 小时涨跌每秒好几帧。标记价就是交易所算已盈亏用的那个价，
        // 所以顶栏、图上摘要、持仓卡的数字都跟着它走，不用等下一次轮询。
        if (msg.type === 'ticker') {
          if (msg.contract === contract) pendingTickerRef.current = msg;
          return;
        }
        if (msg.type === 'candle' && msg.contract === contract) {
          const b = msg.bar;
          // 行情里收到的这根属于哪个 key，就只有那个 key 的快照能收下它
          const key = `${contract}:${interval}`;
          setMarket((prev) => {
            if (prev.key !== key || prev.bars.length === 0) return prev;
            const next = prev.bars.slice();
            const last = next[next.length - 1]!;
            const bar: Bar = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
            if (last.time === b.time) next[next.length - 1] = bar;
            else if (b.time > last.time) {
              // 跳了一根以上：中间那段没收到（断线、丢帧）。先把这一根接上，缺口交给补课
              if (b.time - last.time > intervalSeconds(interval)) void resyncTail();
              next.push(bar);
            } else return prev;
            return { ...prev, bars: next };
          });
          if (b.closed) {
            lastBarRef.current = { at: Date.now(), closed: true };
            void loadLevelsOnly(contract, interval);
          }
        }
      };

      ws.onclose = () => {
        setWsAlive(false);
        if (disposed) return;
        const delay = Math.min(15_000, 600 * 2 ** reconnectRef.current++);
        window.setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => { disposed = true; wsRef.current?.close(); };
  }, [contract, interval, loadLevelsOnly, resyncTail]);

  // ---------- 定时刷新档位（防止 WS 长时间没收到收线事件） ----------

  useEffect(() => {
    const t = window.setInterval(() => void loadLevelsOnly(contract, interval), 45_000);
    return () => window.clearInterval(t);
  }, [contract, interval, loadLevelsOnly]);

  // ---------- 交易解锁 ----------

  /**
   * 落锁：页面这边清掉令牌。
   *
   * 解锁没有时间限制，一直有效到你锁定、切换环境、或者关掉下单开关 ——
   * 只靠一个倒计时兜底，会让盯盘到一半的人莫名其妙被锁在门外。
   */
  const lockTrading = useCallback((title?: string, detail?: string) => {
    setArmed(false);
    setToken(null);
    if (title) push('ok', title, detail);
  }, [push]);

  const toggleArm = useCallback(async () => {
    if (armed) {
      try { await jsend('POST', '/api/trade/arm', { on: false }); } catch { /* ignore */ }
      lockTrading('交易已锁定');
      return;
    }
    try {
      const r = await jsend<{ armed: boolean; token?: string }>('POST', '/api/trade/arm', { on: true });
      if (!r.armed || !r.token) return;
      setArmed(true);
      setToken(r.token);
      // 解锁后一直有效：只有你主动锁定、换环境、或者关掉下单开关才会失效
      push('ok', '交易已解锁', '一直有效，随时可锁定');
    } catch (e) {
      push('err', '无法解锁交易', (e as Error).message);
    }
  }, [armed, lockTrading, push]);

  // 换环境就等于换账户：服务端会把旧令牌全部作废，页面这边也跟着落锁，
  // 免得上一个环境的解锁状态被带到实盘上。
  const envSeenRef = useRef<string | null>(null);
  useEffect(() => {
    const env = config?.env;
    if (!env) return;
    if (envSeenRef.current && envSeenRef.current !== env) {
      lockTrading(
        '环境已切换，交易已锁定',
        (env === 'live' ? '现在打的是实盘，花真钱。' : '现在打的是模拟盘。') + '要交易请重新解锁',
      );
      // 排队等着补挂的保护单属于上一个账户，不能跟着过来
      setProtectQueue([]);
    }
    envSeenRef.current = env;
  }, [config?.env, lockTrading]);

  // 下单开关被关掉时，服务端已经作废了所有令牌，页面不能还显示「已解锁」
  useEffect(() => {
    if (config && !config.liveTrading) lockTrading();
  }, [config, lockTrading]);

  /**
   * 服务端不认这个令牌了：页面跟着落锁。
   *
   * 两条路都走这里 —— 每 3 秒的核对（服务重启、在别处锁定过），
   * 以及某次下单被 NOT_ARMED 当场拒掉。少了这条，页面会一直写着「交易已解锁」，
   * 而每一次操作都只回一句「未解锁交易」。
   */
  useEffect(() => {
    if (!armed || !token) return;
    if (!armCheck || armCheck.token !== token || armCheck.ok) return;
    lockTrading('交易已锁定', '服务端已经不认这次解锁了（服务重启过，或者被锁定过）。要交易请再点一次「解锁交易」');
  }, [armed, token, armCheck, lockTrading]);

  // 哪一步在下单/平仓时被服务端用 NOT_ARMED 拒掉，也立刻落锁
  useEffect(() => {
    setNotArmedHandler(() => {
      // 压根没解锁过的人点下单本来就会看到这句，不必弹两次
      if (!tokenRef.current) return;
      lockTrading('交易已锁定', '服务端已经不认这次解锁了。要交易请再点一次「解锁交易」');
    });
    return () => setNotArmedHandler(null);
  }, [lockTrading]);

  const ticker = useMemo(() => tickers.find((t) => t.contract === contract), [tickers, contract]);
  /**
   * 图上的价格精度优先使用交易所的合约元数据。
   * 元数据暂时不可用时，根据当前行情最新价估算。
   */
  const priceRound = info?.priceRound ?? guessPriceRound(levels?.last ?? 0);
  // 持仓卡里会同时列出别的合约。价格精度按各自的最小变动位算，
  // 否则在 BTC 的 0.1 下看 DOGE 的 0.15，会显示成 0.2。
  const roundMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tickers) {
      const r = t.priceRound ?? 0;
      if (r > 0) m.set(t.contract, r);
    }
    return m;
  }, [tickers]);
  /**
   * 每个合约最新的标记价。持仓卡里可能还列着别的合约，盈亏各按各自的标记价算 ——
   * 交易所的 unrealised_pnl 也是按标记价来的，用最新价算会和交易所差几个点。
   */
  const markMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tickers) if (t.mark > 0) m.set(t.contract, t.mark);
    return m;
  }, [tickers]);

  /** 图上的已盈亏按这个价算，和持仓卡、和交易所同一个价 */
  const markPrice = ticker && ticker.mark > 0 ? ticker.mark : info?.markPrice ?? 0;

  /**
   * 下单面板用的合约信息：现价和标记价换成 ws 的最新一帧，其余（乘数、最小变动、杠杆上限）还是合约元数据。
   * 原来这两项只在切币种时取过一次，现价能停在十几秒前 —— 限价、止损方向、风险张数全按旧价算。
   */
  const liveInfo = useMemo(() => {
    if (!info) return null;
    if (!ticker) return info;
    return {
      ...info,
      price: ticker.last > 0 ? ticker.last : info.price,
      markPrice: ticker.mark > 0 ? ticker.mark : info.markPrice,
    };
  }, [info, ticker]);

  // 行情每 300ms 刷一次，这几条过滤不能跟着重算：
  // 数组换一份新的，图表就会把价格线全部拆了重画一遍。
  const myPositions = useMemo(() => positions.filter((p) => p.contract === contract), [positions, contract]);
  const myOrders = useMemo(() => orders.filter((o) => o.contract === contract), [orders, contract]);

  /**
   * 私有数据停更了没有。停更时页面上的仓位、均价、盈亏全是旧快照 ——
   * 不说清楚的话，用户会以为图上的均价线画错了。
   */
  const privateStale = privateErr
    ? { err: privateErr, ageMs: privateAt > 0 ? Date.now() - privateAt : 0 }
    : null;


  const onManualLevels = useCallback((prices: number[]) => setManualLevels(prices), []);

  return (
    <>
      <div ref={appRootRef} className={`app${railOpen ? ' rail-open' : ''}${railCollapsed ? ' rail-collapsed' : ''}${view === 'research' ? ' research-mode' : ''}${view === 'ai' ? ' ai-mode' : ''}${view === 'quant' ? ' ai-mode' : ''}`}>
        <TopBar
          exchange={config?.exchangeLabel ?? 'Gate'}
          env={config?.env ?? 'live'}
          ticker={ticker}
          view={view}
          onView={setView}
          aiOn={aiOn}
          priceRound={priceRound}
          interval={interval}
          wsAlive={wsAlive}
          armed={armed}
          liveTrading={config?.liveTrading ?? false}
          keysConfigured={config?.keys.configured ?? false}
          onToggleArm={toggleArm}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenRail={() => setRailOpen(true)}
          railCollapsed={railCollapsed}
          onToggleRail={() => setRailCollapsed((collapsed) => !collapsed)}
        />

        <ContractRail
          tickers={tickers}
          current={contract}
          onSelect={(name) => { setContract(name); setRailOpen(false); }}
          showTradable={config?.env === 'testnet'}
          onClose={() => setRailOpen(false)}
        />
        {railOpen && <div className="rail-scrim" onClick={() => setRailOpen(false)} />}

        <main className="center">
          <ChartPane
            contract={contract}
            interval={interval}
            bars={bars}
            // 历史位一起交给图：这次没算出来但还留着的那几条，画淡一点
            zones={[...(levels?.zones ?? []), ...(levels?.historyZones ?? [])]}

            positions={myPositions}
            orders={myOrders}
            priceOrders={priceOrders}
            account={account}

            multiplier={info?.multiplier ?? 0}
            markPrice={markPrice}
            priceRound={priceRound}
            stale={privateStale}
            resetKey={marketKey}
            loading={loading}
            historyEnd={historyEnd}
            backfilling={backfilling}
            onNeedOlder={needOlder}
            intervals={config?.intervals}
            onIntervalChange={setInterval}
            onManualLevels={onManualLevels}
            canClose={armed && Boolean(token)}
            onClosePosition={(name, dir) => { void closeFromChart(name, dir); }}
            onPickPrice={pickPrice}
            hasPosition={myPositions.length > 0}
          />
          <LevelsStrip
            zones={levels?.zones ?? []}
            manual={manualLevels}
            price={ticker?.last || levels?.last || 0}
            priceRound={priceRound}
            atr={levels?.atr ?? 0}
            levelsError={levelsError}

          />
        </main>

        {researchMounted && (
          /**
           * 用 hidden 而不是卸掉：分析结果、扫描结果、图表视口都留在原地，
           * 切回来还是刚才看到的那一屏。display:none 由浏览器给。
           */
          <main className="research-main" hidden={view !== 'research'}>
            {/* 研究台的品种和周期独立于日内台的交易所行情。 */}
            <ResearchDesk
              canPick={canPickLocal}
              dir={local}
              symbol={localSym}
              tf={localPick?.tf ?? localTf}
              onSymbol={setLocalSym}
              onTf={setLocalTf}
              onPickDir={pickLocalDir}
              onToast={push}
            />
          </main>
        )}

        {aiMounted && (
          /**
           * 和上面研究台那块一样用 hidden 藏起来：决策流、表单里填了一半的数、
           * 展开的角色发言都留在原地，切回来还是刚才那一屏。
           */
          <main className="ai-main" hidden={view !== 'ai'}>
            <AiTradingDesk
              env={config?.env ?? 'live'}
              liveTrading={config?.liveTrading ?? false}
              canEdit={canPickLocal}
              onToast={push}
            />
          </main>
        )}

        {quantMounted && (
          <main className="ai-main" hidden={view !== 'quant'}>
            <QuantDesk canRun={canPickLocal} onToast={push} />
          </main>
        )}

        <aside className="side">

          <OrderTicket
            contract={liveInfo}

            armed={armed}
            token={token}
            account={account}
            accountError={accountError}
            privateError={privateErr}
            liveTrading={config?.liveTrading ?? false}
            env={config?.env ?? 'live'}
            keysConfigured={config?.keys.configured ?? false}
            posPct={posPct}
            onPosPctChange={setPosPct}
            onToast={push}
            onRefresh={loadPrivate}
            onQueueProtect={queueProtect}
            limitStr={limitStr}
            onLimitChange={setLimitStr}
            stopStr={stopStr}
            onStopChange={setStopStr}
            targetStr={targetStr}
            onTargetChange={setTargetStr}
            priceMode={priceMode}
            onPriceModeChange={setPriceMode}
            onResetPrices={resetTicketPrices}
          />

          <PositionsCard
            account={account}
            positions={positions}
            orders={orders}
            priceOrders={priceOrders}
            priceRound={priceRound}
            rounds={roundMap}
            marks={markMap}
            stale={privateStale}
            armed={armed}
            token={token}
            onToast={push}
            onRefresh={loadPrivate}
          />

          <NewsCard
            digest={news && news.contract === contract ? news : null}
            contract={contract}
            loading={newsLoading}
          />

          <AiCard
            contract={contract}
            interval={interval}
            configured={config?.ai.configured ?? false}
            liveTrading={config?.liveTrading ?? false}
            env={config?.env ?? 'live'}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </aside>
      </div>

      {settingsOpen && (
        <SettingsDialog
          config={config}
          contract={contract}
          interval={interval}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => { void loadConfig(); void loadPrivate(); }}
          onToast={push}
        />
      )}

      <div className="toast-host">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <b>{t.title}</b>
            {t.detail && <div className="muted" style={{ marginTop: 2, wordBreak: 'break-word' }}>{t.detail}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
