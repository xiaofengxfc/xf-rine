import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  jget, jsend,
  type Account, type AppConfig, type Bar, type Bracket, type ContractInfo,
  type CloseResult, type LevelsResponse, type LiveTicker, type NewsDigest, type OpenOrder, type Pattern, type Position,
  type PrivateState, type PriceOrder, type Ticker, type WsMessage,
} from './lib/api.ts';
import { fmtPrice } from './lib/format.ts';
import { INTERVAL_SEC, mergeNewer, mergeOlder } from './lib/candles.ts';
import { backfill } from './lib/backfill.ts';
import { wsUrl } from './lib/endpoint.ts';
import ChartPane from './components/ChartPane.tsx';
import ContractRail from './components/ContractRail.tsx';
import TopBar from './components/TopBar.tsx';
import LevelsStrip from './components/LevelsStrip.tsx';
import BracketsCard from './components/BracketsCard.tsx';
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
}

const EMPTY_BARS: Bar[] = [];
const EMPTY_PATTERNS: Pattern[] = [];
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
const DEFAULT_CONTRACT = 'BTC_USDT';
/** 解锁令牌的有效期，和服务端 routes.ts 的 ARM_TTL_MS 对齐 */
const ARM_TTL_MS = 10 * 60 * 1000;
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

interface Prefs {
  contract: string;
  interval: string;
  side: 'long' | 'short';
  riskPct: number;
}

const DEFAULT_PREFS: Prefs = { contract: DEFAULT_CONTRACT, interval: '15m', side: 'long', riskPct: 1 };

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
 * 记住上次在看什么：币种、周期、看多还是看空、风险百分比。
 * 刷新一次就跳回 BTC/15m/看多很烦，但这只是偏好，
 * 读坏了就当没存过，绝不能让页面因此起不来。
 */
function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    return {
      contract: isContractName(raw.contract) ? raw.contract : DEFAULT_PREFS.contract,
      interval: typeof raw.interval === 'string' && INTERVALS.includes(raw.interval) ? raw.interval : DEFAULT_PREFS.interval,
      side: raw.side === 'short' ? 'short' : 'long',
      riskPct: typeof raw.riskPct === 'number' && raw.riskPct > 0 && raw.riskPct <= 100 ? raw.riskPct : DEFAULT_PREFS.riskPct,
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
  const prefs0 = useRef(readPrefs()).current;
  const [contract, setContract] = useState(prefs0.contract);
  const [interval, setInterval] = useState(prefs0.interval);
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [market, setMarket] = useState<MarketSnap>(EMPTY_MARKET);
  const [news, setNews] = useState<NewsDigest | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [priceOrders, setPriceOrders] = useState<PriceOrder[]>([]);
  /** 私有数据最后一次成功刷新的时刻，以及失败原因（失败时界面要直说，不能装作还是新的） */
  const [privateAt, setPrivateAt] = useState(0);
  const [privateErr, setPrivateErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [wsAlive, setWsAlive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 手机上左栏是抽屉：点顶栏的「合约」打开，选完自动收 */
  const [railOpen, setRailOpen] = useState(false);
  const [manualLevels, setManualLevels] = useState<number[]>([]);
  const [applied, setApplied] = useState<{ bracket: Bracket; at: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [side, setSide] = useState<'long' | 'short'>(prefs0.side);
  const [riskPct, setRiskPct] = useState(prefs0.riskPct);
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
  /** 解锁令牌的到期计时器 */
  const armTimerRef = useRef(0);
  const lastBarRef = useRef<{ at: number; closed: boolean }>({ at: 0, closed: true });
  /** 行情请求序号。切币种时让晚回来的旧请求作废。 */
  const marketSeqRef = useRef(0);
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
      if (railOpen) { e.preventDefault(); setRailOpen(false); }
    };
    window.addEventListener('xf-back', onBack);
    return () => window.removeEventListener('xf-back', onBack);
  }, [settingsOpen, railOpen]);

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

  const marketKey = `${contract}:${interval}`;
  // 只有归属当前币种和周期的数据才交给界面。切币那一帧旧数据还在 state 里，
  // 这一层直接挡掉，图表和右侧面板就不可能显示上一个币种的价格。
  const fresh = market.key === marketKey;
  const info = fresh ? market.info : null;
  const bars = fresh ? market.bars : EMPTY_BARS;
  const levels = fresh ? market.levels : null;

  const push = useCallback((kind: 'ok' | 'err', title: string, detail?: string) => {
    const id = toastSeq++;
    setToasts((t) => [...t.slice(-4), { id, kind, title, detail }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 9000 : 5000);
  }, []);

  /**
   * 把能拿的历史一路补到底。
   *
   * 拖动只是再催一次：正在补的时候直接返回，不重复开一轮。
   * 补到交易所到头、本地上限、或者切了币种为止，中间不停 ——
   * 以前一页一页等拖动事件催，用户不动历史就停在原地。
   */
  const backfillOlder = useCallback(async () => {
    const key = marketRef.current.key;
    if (!key || marketRef.current.bars.length === 0) return;
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
      if (pumpGenRef.current === gen) {
        pumpingKeyRef.current = '';
        setBackfilling(false);
      }
    }
  }, [push]);

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
  }, []);

  /**
   * 尾部看门狗：最后一根落后超过 3 个周期就补一次。
   *
   * 推送正常时这里一次请求都不会发（BTC 这种每秒都在推）；只有推送真停了才动 ——
   * 比如 Gate 断过、这枚币很久没成交、或者订阅没接上。
   */
  useEffect(() => {
    const step = INTERVAL_SEC[interval] ?? 60;
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
  useEffect(() => { savePrefs({ contract, interval, side, riskPct }); }, [contract, interval, side, riskPct]);

  const loadMarket = useCallback(async (name: string, tf: string) => {
    const key = `${name}:${tf}`;
    const seq = ++marketSeqRef.current;
    noMoreOlderRef.current = false;
    setHistoryEnd(false);
    setLoading(true);
    try {
      const [c, k, lv] = await Promise.all([
        jget<ContractInfo>(`/api/contracts/${name}`),
        // 首屏直接要满一页：一页一千根，剩下的交给后台补
        jget<{ bars: Bar[] }>(`/api/candles?contract=${name}&interval=${tf}&limit=${OLDER_PAGE}`),
        jget<LevelsResponse>(`/api/levels?contract=${name}&interval=${tf}&limit=500`),
      ]);
      // 期间又切过币种，这份数据已经不是当前要看的东西了
      if (seq !== marketSeqRef.current) return;
      setMarket({ key, info: c, bars: k.bars, levels: lv });
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
      setMarket((prev) => (prev.key === key ? { ...prev, levels: lv } : prev));
    } catch { /* 静默 */ }
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
    if (!config?.keys.configured) return;
    const seq = ++privateSeqRef.current;
    try {
      // 一次取全：账户、持仓、委托、触发单。分四次发的话，四份回包来自四个时刻，
      // 持仓和它的止损单可能一个新一个旧，看起来就像「止损没挂上」。
      const s = await jget<PrivateState>('/api/private-state');
      if (seq !== privateSeqRef.current) return;
      setAccount(s.account); setPositions(s.positions); setOrders(s.orders); setPriceOrders(s.priceOrders);
      setPrivateAt(Date.now());
      setPrivateErr(null);
    } catch (e) {
      // 服务端挂了或者交易所一直报错时，页面原来会一声不响地停在最后一份快照上 ——
      // 仓位、均价、盈亏全是旧的，看着就像「线画错了」。现在把它记下来，界面上直说。
      if (seq !== privateSeqRef.current) return;
      setPrivateErr((e as Error).message || '刷新失败');
    }
  }, [config?.keys.configured]);

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

  useEffect(() => { void loadConfig(); void loadTickers(); }, [loadConfig, loadTickers]);
  useEffect(() => { void loadMarket(contract, interval); }, [contract, interval, loadMarket]);

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
        // 方案是按挂单价算的。真成交价离它太远时，这套止损可能已经站到仓位的另一边 ——
        // 那样的触发单一挂上就成交，等于市价平仓。宁可先不挂，说清楚让人重算。
        const wrong = q.stop > 0 && (q.direction === 'long' ? q.stop >= pos.entryPrice : q.stop <= pos.entryPrice);
        if (wrong) {
          push(
            'err',
            '这套止损已经站错边了，没有补挂',
            q.contract + ' 成交价越过了方案止损。用持仓卡里的「套用方案」按真实成本重算一遍。',
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
      // 地址和口令都由 endpoint 决定：浏览器同源，手机端拼到电脑上
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
              if (b.time - last.time > (INTERVAL_SEC[interval] ?? 60)) void resyncTail();
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

  /** 落锁：清掉本地令牌和到期计时器。服务端那边的令牌到点也会失效，两边一起走 */
  const clearArmTimer = useCallback(() => {
    if (armTimerRef.current) { window.clearTimeout(armTimerRef.current); armTimerRef.current = 0; }
  }, []);

  const lockTrading = useCallback((title?: string, detail?: string) => {
    clearArmTimer();
    setArmed(false);
    setToken(null);
    if (title) push('ok', title, detail);
  }, [clearArmTimer, push]);

  const toggleArm = useCallback(async () => {
    if (armed) {
      try { await jsend('POST', '/api/trade/arm', { on: false }); } catch { /* ignore */ }
      lockTrading('交易已锁定');
      return;
    }
    try {
      const r = await jsend<{ armed: boolean; token?: string; expiresAt?: number }>('POST', '/api/trade/arm', { on: true });
      if (!r.armed || !r.token) return;
      setArmed(true);
      setToken(r.token);
      const left = Math.max(1000, (r.expiresAt ?? Date.now() + ARM_TTL_MS) - Date.now());
      clearArmTimer();
      // 到点自动落锁。不这么做的话，页面上会一直写着「交易已解锁」，
      // 直到某次下单被服务端用 NOT_ARMED 拒掉才发现早就过期了。
      armTimerRef.current = window.setTimeout(() => {
        lockTrading('交易已自动锁定', '解锁有效期 10 分钟，要接着交易请再点一次「解锁交易」');
      }, left);
      push('ok', '交易已解锁', '10 分钟内有效，随时可锁定');
    } catch (e) {
      push('err', '无法解锁交易', (e as Error).message);
    }
  }, [armed, clearArmTimer, lockTrading, push]);

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

  useEffect(() => clearArmTimer, [clearArmTimer]);

  const ticker = useMemo(() => tickers.find((t) => t.contract === contract), [tickers, contract]);
  const priceRound = info?.priceRound ?? 0.1;
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
  const myTriggers = useMemo(() => priceOrders.filter((o) => o.contract === contract), [priceOrders, contract]);

  /**
   * 私有数据停更了没有。停更时页面上的仓位、均价、盈亏全是旧快照 ——
   * 不说清楚的话，用户会以为图上的均价线画错了。
   */
  const privateStale = privateErr
    ? { err: privateErr, ageMs: privateAt > 0 ? Date.now() - privateAt : 0 }
    : null;

  const bracketForSide = side === 'long' ? levels?.brackets.long ?? null : levels?.brackets.short ?? null;

  const onManualLevels = useCallback((prices: number[]) => setManualLevels(prices), []);

  return (
    <>
      <div className={`app${railOpen ? ' rail-open' : ''}`}>
        <TopBar
          env={config?.env ?? 'live'}
          ticker={ticker}
          priceRound={priceRound}
          interval={interval}
          wsAlive={wsAlive}
          armed={armed}
          liveTrading={config?.liveTrading ?? false}
          keysConfigured={config?.keys.configured ?? false}
          onToggleArm={toggleArm}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenRail={() => setRailOpen(true)}
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
            levels={levels?.levels ?? []}
            patterns={fresh ? (levels?.patterns ?? EMPTY_PATTERNS) : EMPTY_PATTERNS}
            bracket={bracketForSide}
            positions={myPositions}
            orders={myOrders}
            priceOrders={myTriggers}
            multiplier={info?.multiplier ?? 0}
            markPrice={markPrice}
            priceRound={priceRound}
            stale={privateStale}
            resetKey={`${contract}:${interval}`}
            loading={loading}
            historyEnd={historyEnd}
            backfilling={backfilling}
            onNeedOlder={needOlder}
            onIntervalChange={setInterval}
            onManualLevels={onManualLevels}
            canClose={armed && Boolean(token)}
            onClosePosition={(name, dir) => { void closeFromChart(name, dir); }}
          />
          <LevelsStrip
            levels={levels?.levels ?? []}
            manual={manualLevels}
            price={ticker?.last || levels?.last || 0}
            priceRound={priceRound}
            atr={levels?.atr ?? 0}
            structure={levels?.structure}
          />
        </main>

        <aside className="side">
          <div className="card side-pick">
            <div className="card-body" style={{ paddingTop: 10 }}>
              <div className="seg" style={{ width: '100%' }}>
                <button className={side === 'long' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setSide('long')}>看多</button>
                <button className={side === 'short' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setSide('short')}>看空</button>
              </div>
            </div>
          </div>

          <BracketsCard
            long={levels?.brackets.long ?? null}
            short={levels?.brackets.short ?? null}
            priceRound={priceRound}
            multiplier={info?.multiplier ?? 0}
            equity={account?.total ?? 0}
            available={account?.available ?? 0}
            feeRate={info?.takerFee ?? 0}
            riskPercent={riskPct}
            leverageMax={Math.min(info?.leverageMax ?? 125, 125)}
            onUse={(b) => { setApplied({ bracket: b, at: Date.now() }); setSide(b.direction); push('ok', '已套用方案', `${b.direction === 'long' ? '做多' : '做空'} 止损 ${fmtPrice(b.stop, priceRound)} / 止盈 ${fmtPrice(b.target, priceRound)}`); }}
          />

          <OrderTicket
            contract={liveInfo}
            bracket={bracketForSide}
            applied={applied}
            armed={armed}
            token={token}
            account={account}
            liveTrading={config?.liveTrading ?? false}
            env={config?.env ?? 'live'}
            keysConfigured={config?.keys.configured ?? false}
            riskPct={riskPct}
            onRiskPctChange={setRiskPct}
            onToast={push}
            onRefresh={loadPrivate}
            onQueueProtect={queueProtect}
          />

          <PositionsCard
            positions={positions}
            orders={orders}
            priceOrders={priceOrders}
            interval={interval}
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
