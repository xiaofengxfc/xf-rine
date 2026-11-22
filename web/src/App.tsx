import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  jget, jsend,
  type AppConfig, type Bar, type CloseResult, type NewsDigest,
  type LocalDirInfo,
} from './lib/api.ts';
import { fmtPrice, guessPriceRound } from './lib/format.ts';
import { sumUnrealisedPnl } from './lib/position.ts';
import ChartPane, { type PricePick } from './components/ChartPane.tsx';
import ContractRail from './components/ContractRail.tsx';
import TopBar from './components/TopBar.tsx';
import ResearchDesk from './components/ResearchDesk.tsx';
import AiTradingDesk from './components/AiTradingDesk.tsx';
import QuantDesk from './components/QuantDesk.tsx';
import LevelsStrip from './components/LevelsStrip.tsx';
import OrderTicket from './components/OrderTicket.tsx';
import PositionsCard from './components/PositionsCard.tsx';
import NewsCard from './components/NewsCard.tsx';
import AiCard from './components/AiCard.tsx';
import SettingsDialog from './components/SettingsDialog.tsx';
import UpdateDialog from './components/UpdateDialog.tsx';
import { useDeskNavigation } from './hooks/useDeskNavigation.ts';
import { useMarketFeed } from './hooks/useMarketFeed.ts';
import { useTradingSession } from './hooks/useTradingSession.ts';
import { useUserPreferences } from './hooks/useUserPreferences.ts';
import {
  checkForUpdate,
  clearPendingUpdate,
  compareVersions,
  decideUpdate,
  desktopBridge,
  isDesktopClient,
  markVersion,
  readPendingUpdate,
  seenVersion,
  type UpdateCheck,
} from './lib/update.ts';
import { isNative } from './lib/endpoint.ts';

interface Toast { id: number; kind: 'ok' | 'err'; title: string; detail?: string }

const EMPTY_BARS: Bar[] = [];
let toastSeq = 1;

export default function App() {
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const { contract, setContract, interval, setInterval, posPct, setPosPct } = useUserPreferences();
  const [news, setNews] = useState<NewsDigest | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const {
    view,
    setView,
    researchMounted,
    aiMounted,
    quantMounted,
    railOpen,
    setRailOpen,
    railCollapsed,
    setRailCollapsed,
  } = useDeskNavigation({ settingsOpen, closeSettings });
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
  /** 更新提示。mode 是「有新版」还是「刚装完」，两者共用同一个弹窗 */
  const [update, setUpdate] = useState<{ mode: 'available' | 'updated'; info: UpdateCheck } | null>(null);
  /** 刚装完那一版的说明看过之后，如果还有更新的版本，接着弹出来 */
  const [updateAfter, setUpdateAfter] = useState<UpdateCheck | null>(null);

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

  const newsSeqRef = useRef(0);


  /** 研究台本地数据的品种/周期。周期不在这个品种里就退回它有的第一个 */
  const localPick = useMemo(() => {
    const inst = local?.instruments.find((i) => i.symbol === localSym);
    if (!inst) return null;
    const tf = inst.timeframes.includes(localTf) ? localTf : (inst.timeframes[0] ?? 'D1');
    return { symbol: inst.symbol, tf };
  }, [local, localSym, localTf]);

  const push = useCallback((kind: 'ok' | 'err', title: string, detail?: string) => {
    const id = toastSeq++;
    setToasts((t) => [...t.slice(-4), { id, kind, title, detail }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 9000 : 5000);
  }, []);

  const {
    tickers,
    market,
    wsAlive,
    loading,
    historyEnd,
    backfilling,
    needOlder,
    resyncTail,
  } = useMarketFeed({ contract, interval, setContract, onToast: push });
  const marketKey = `${contract}:${interval}`;
  const fresh = market.key === marketKey;
  const info = fresh ? market.info : null;
  const bars = fresh ? market.bars : EMPTY_BARS;
  const levels = fresh ? market.levels : null;
  const levelsError = fresh ? market.levelsError : null;

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

  // ---------- 只读数据 ----------

  const loadConfig = useCallback(async () => {
    try { setConfig(await jget<AppConfig>('/api/config')); } catch { /* 静默 */ }
  }, []);

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

  const clearProtectionQueue = useCallback(() => setProtectQueue([]), []);
  const {
    account,
    accountError,
    dailyRealisedPnl,
    dailyPnlError,
    positions,
    orders,
    priceOrders,
    privateAt,
    privateErr,
    armed,
    token,
    loadPrivate,
    toggleArm,
  } = useTradingSession({
    config,
    onToast: push,
    onResyncTail: resyncTail,
    onEnvironmentChange: clearProtectionQueue,
  });

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
    const mine = priceOrders.filter((o) => o.contract === contract && o.direction === pos.direction && o.protective);
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

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  /**
   * 自动更新：启动时问一次有没有新版。
   *
   * 只在装好的程序里查（桌面外壳、手机 App）：浏览器里打开页面没有安装包可装。
   * 桌面端刚装完的那一次优先用本地存的说明 —— 装完第一次启动可能连不上网。
   * 其余情况看版本：上次启动的版本比现在低，或服务端说当前这版比上次新，就算刚升级完。
   * 离线、没配令牌、限流，这里都安安静静，不往页面上写红字。
   */
  useEffect(() => {
    if (!isDesktopClient() && !isNative()) return;
    let alive = true;

    // 桌面外壳能同步给出当前版本；开始安装前存下的那份说明，装完第一次启动离线也能用
    const bridge = desktopBridge();
    const installed = bridge?.version ?? '';
    const pending = readPendingUpdate();
    if (pending) clearPendingUpdate();

    const apply = (result: UpdateCheck | null) => {
      const decision = decideUpdate({ installed, pending, seen: seenVersion(), result });
      if (decision.remember) markVersion(decision.remember);
      if (decision.mode === 'none' || !decision.info) return;
      setUpdate({ mode: decision.mode, info: decision.info });
      if (decision.after) setUpdateAfter(decision.after);
    };

    // 刚装完就先弹这一版的说明，不用等网络
    if (installed && pending && compareVersions(pending.version, installed) === 0) {
      apply(null);
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await checkForUpdate();
        if (!alive) return;
        apply(result);
      })();
    }, 3000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  /** 关掉更新弹窗。刚装完的那一个关掉后，接着提示后面还有的新版本 */
  const closeUpdate = useCallback(() => {
    if (update?.mode === 'updated' && updateAfter) {
      const next = updateAfter;
      setUpdateAfter(null);
      setUpdate({ mode: 'available', info: next });
      return;
    }
    setUpdate(null);
  }, [update, updateAfter]);

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

  const currentPositionPnl = useMemo(
    () => sumUnrealisedPnl(positions),
    [positions],
  );

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
            dailyRealisedPnl={dailyRealisedPnl}
            dailyPnlError={dailyPnlError}
            currentPnl={privateAt > 0 ? currentPositionPnl : null}
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

      {update && (
        <UpdateDialog mode={update.mode} info={update.info} onClose={closeUpdate} />
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
