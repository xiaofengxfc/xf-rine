import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  jget, jsend,
  type Account, type AppConfig, type Bar, type Bracket, type ContractInfo,
  type LevelsResponse, type LiveBar, type NewsDigest, type OpenOrder, type Pattern, type Position, type PriceOrder, type Ticker,
} from './lib/api.ts';
import { fmtPrice } from './lib/format.ts';
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

const PREFS_KEY = 'xf-rine:prefs';
const DEFAULT_CONTRACT = 'BTC_USDT';
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

interface Prefs {
  contract: string;
  interval: string;
  side: 'long' | 'short';
  riskPct: number;
}

const DEFAULT_PREFS: Prefs = { contract: DEFAULT_CONTRACT, interval: '15m', side: 'long', riskPct: 1 };

/**
 * 记住上次在看什么：币种、周期、看多还是看空、风险百分比。
 * 刷新一次就跳回 BTC/15m/看多很烦，但这只是偏好，
 * 读坏了就当没存过，绝不能让页面因此起不来。
 */
function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    return {
      contract: typeof raw.contract === 'string' && /^[A-Z0-9_]{2,24}$/.test(raw.contract) ? raw.contract : DEFAULT_PREFS.contract,
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
  const [armed, setArmed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [wsAlive, setWsAlive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualLevels, setManualLevels] = useState<number[]>([]);
  const [applied, setApplied] = useState<{ bracket: Bracket; at: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [side, setSide] = useState<'long' | 'short'>(prefs0.side);
  const [riskPct, setRiskPct] = useState(prefs0.riskPct);
  /** 限价单带止盈止损下的单：等它成交、持仓出现，再把保护补上 */
  const [protectQueue, setProtectQueue] = useState<{ id: number; contract: string; direction: 'long' | 'short'; stop: number; target: number; at: number }[]>([]);
  const protectSeq = useRef(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number>(0);
  const lastBarRef = useRef<{ at: number; closed: boolean }>({ at: 0, closed: true });
  /** 行情请求序号。切币种时让晚回来的旧请求作废。 */
  const marketSeqRef = useRef(0);
  /** 历史 K 线：正在拉 / 已经到头，避免拖到边缘时反复请求 */
  const olderBusyRef = useRef(false);
  const noMoreOlderRef = useRef(false);
  const marketRef = useRef(market);
  useEffect(() => { marketRef.current = market; }, [market]);
  const newsSeqRef = useRef(0);

  const marketKey = `${contract}:${interval}`;
  // 只有归属当前币种和周期的数据才交给界面。切币那一帧旧数据还在 state 里，
  // 这一层直接挡掉，图表和右侧面板就不可能显示上一个币种的价格。
  const fresh = market.key === marketKey;
  const info = fresh ? market.info : null;
  const bars = fresh ? market.bars : EMPTY_BARS;
  const levels = fresh ? market.levels : null;

  /** 往左拖到底时补一页历史。失败就静默，用户再拖一次会重试。 */
  const loadOlder = useCallback(async () => {
    if (olderBusyRef.current || noMoreOlderRef.current) return;
    const cur = marketRef.current;
    if (!cur.bars.length || cur.key === '') return;
    olderBusyRef.current = true;
    try {
      const [name, tf] = cur.key.split(':') as [string, string];
      const before = cur.bars[0]!.time;
      const r = await jget<{ bars: Bar[] }>(
        `/api/candles?contract=${name}&interval=${tf}&limit=500&before=${before}`,
      );
      if (r.bars.length === 0) { noMoreOlderRef.current = true; return; }
      setMarket((prev) => {
        if (prev.key !== cur.key) return prev;
        const seen = new Set(prev.bars.map((b) => b.time));
        const add = r.bars.filter((b) => !seen.has(b.time));
        if (add.length === 0) { noMoreOlderRef.current = true; return prev; }
        const merged = [...add, ...prev.bars].sort((a, b) => a.time - b.time);
        // 内存里的历史别无限长，3000 根足够看几天
        if (merged.length > 3000) noMoreOlderRef.current = true;
        return { ...prev, bars: merged.slice(-3000) };
      });
    } catch {
      /* 静默失败，拖回去会再试 */
    } finally {
      olderBusyRef.current = false;
    }
  }, []);

  const push = useCallback((kind: 'ok' | 'err', title: string, detail?: string) => {
    const id = toastSeq++;
    setToasts((t) => [...t.slice(-4), { id, kind, title, detail }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 9000 : 5000);
  }, []);

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
    setLoading(true);
    try {
      const [c, k, lv] = await Promise.all([
        jget<ContractInfo>(`/api/contracts/${name}`),
        jget<{ bars: Bar[] }>(`/api/candles?contract=${name}&interval=${tf}&limit=500`),
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

  const queueProtect = useCallback((p: { contract: string; direction: 'long' | 'short'; stop: number; target: number }) => {
    setProtectQueue((list) => [...list, { ...p, id: ++protectSeq.current, at: Date.now() }]);
  }, []);

  const loadPrivate = useCallback(async () => {
    if (!config?.keys.configured) return;
    try {
      const [a, p, o, t] = await Promise.all([
        jget<Account>('/api/account'),
        jget<Position[]>('/api/positions'),
        jget<OpenOrder[]>('/api/orders'),
        jget<PriceOrder[]>('/api/price-orders'),
      ]);
      setAccount(a); setPositions(p); setOrders(o); setPriceOrders(t);
    } catch { /* 私有接口挂了不影响看盘 */ }
  }, [config?.keys.configured]);

  useEffect(() => { void loadConfig(); void loadTickers(); }, [loadConfig, loadTickers]);
  useEffect(() => { void loadMarket(contract, interval); }, [contract, interval, loadMarket]);

  useEffect(() => {
    const t = window.setInterval(() => void loadTickers(), 12_000);
    return () => window.clearInterval(t);
  }, [loadTickers]);

  useEffect(() => {
    void loadPrivate();
    const t = window.setInterval(() => void loadPrivate(), 6_000);
    return () => window.clearInterval(t);
  }, [loadPrivate]);

  // 限价单成交之后才挂得上保护。持仓一出现就补挂一次，挂完或者等太久就把这条丢掉。
  useEffect(() => {
    if (!armed || !token || protectQueue.length === 0) return;
    for (const q of protectQueue) {
      const open = positions.some((p) => p.contract === q.contract && p.direction === q.direction && p.size > 0);
      const stale = Date.now() - q.at > 30 * 60_000;
      if (!open && !stale) continue;
      setProtectQueue((list) => list.filter((x) => x.id !== q.id));
      if (!open) continue;
      // 这一边已经有保护单了就别覆盖用户后来手动挂的那套
      if (priceOrders.some((o) => o.contract === q.contract && o.direction === q.direction)) continue;
      void jsend('POST', '/api/bracket', { contract: q.contract, direction: q.direction, stop: q.stop, target: q.target }, token)
        .then(() => { push('ok', '保护单已补挂', `${q.contract} · ${q.direction === 'long' ? '多' : '空'}`); void loadPrivate(); })
        .catch((e) => push('err', '补挂保护失败', (e as Error).message));
    }
  }, [armed, token, positions, priceOrders, protectQueue, push, loadPrivate]);

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
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsAlive(true);
        reconnectRef.current = 0;
        ws.send(JSON.stringify({ type: 'subscribe', contract, interval }));
      };

      ws.onmessage = (ev) => {
        let msg: { type?: string; contract?: string; bar?: LiveBar };
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'candle' && msg.bar && msg.contract === contract) {
          const b = msg.bar;
          // 行情里收到的这根属于哪个 key，就只有那个 key 的快照能收下它
          const key = `${contract}:${interval}`;
          setMarket((prev) => {
            if (prev.key !== key || prev.bars.length === 0) return prev;
            const next = prev.bars.slice();
            const last = next[next.length - 1]!;
            const bar: Bar = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
            if (last.time === b.time) next[next.length - 1] = bar;
            else if (b.time > last.time) next.push(bar);
            else return prev;
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
  }, [contract, interval, loadLevelsOnly]);

  // ---------- 定时刷新档位（防止 WS 长时间没收到收线事件） ----------

  useEffect(() => {
    const t = window.setInterval(() => void loadLevelsOnly(contract, interval), 45_000);
    return () => window.clearInterval(t);
  }, [contract, interval, loadLevelsOnly]);

  // ---------- 交易解锁 ----------

  const toggleArm = useCallback(async () => {
    if (armed) {
      try { await jsend('POST', '/api/trade/arm', { on: false }); } catch { /* ignore */ }
      setArmed(false); setToken(null);
      push('ok', '交易已锁定');
      return;
    }
    try {
      const r = await jsend<{ armed: boolean; token?: string }>('POST', '/api/trade/arm', { on: true });
      if (r.armed && r.token) { setArmed(true); setToken(r.token); push('ok', '交易已解锁', '10 分钟内有效，随时可锁定'); }
    } catch (e) {
      push('err', '无法解锁交易', (e as Error).message);
    }
  }, [armed, push]);

  const ticker = useMemo(() => tickers.find((t) => t.contract === contract), [tickers, contract]);
  const priceRound = info?.priceRound ?? 0.1;
  const bracketForSide = side === 'long' ? levels?.brackets.long ?? null : levels?.brackets.short ?? null;

  const onManualLevels = useCallback((prices: number[]) => setManualLevels(prices), []);

  return (
    <>
      <div className="app">
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
        />

        <ContractRail
          tickers={tickers}
          current={contract}
          onSelect={setContract}
          showTradable={config?.env === 'testnet'}
        />

        <main className="center">
          <ChartPane
            contract={contract}
            interval={interval}
            bars={bars}
            levels={levels?.levels ?? []}
            patterns={fresh ? (levels?.patterns ?? EMPTY_PATTERNS) : EMPTY_PATTERNS}
            bracket={bracketForSide}
            positions={positions.filter((p) => p.contract === contract)}
            resetKey={`${contract}:${interval}`}
            loading={loading}
            onNeedOlder={loadOlder}
            onIntervalChange={setInterval}
            onManualLevels={onManualLevels}
          />
          <LevelsStrip
            levels={levels?.levels ?? []}
            manual={manualLevels}
            price={levels?.last ?? ticker?.last ?? 0}
            priceRound={priceRound}
            atr={levels?.atr ?? 0}
          />
        </main>

        <aside className="side">
          <div className="card">
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
            riskPercent={riskPct}
            onUse={(b) => { setApplied({ bracket: b, at: Date.now() }); setSide(b.direction); push('ok', '已套用方案', `${b.direction === 'long' ? '做多' : '做空'} 止损 ${fmtPrice(b.stop, priceRound)} / 止盈 ${fmtPrice(b.target, priceRound)}`); }}
          />

          <OrderTicket
            contract={info}
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
            currentContract={contract}
            longBracket={levels?.brackets.long ?? null}
            shortBracket={levels?.brackets.short ?? null}
            priceRound={priceRound}
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
