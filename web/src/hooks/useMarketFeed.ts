import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  jget,
  type Bar,
  type ContractInfo,
  type LevelsResponse,
  type LiveTicker,
  type Ticker,
  type WsMessage,
} from '../lib/api.ts';
import { backfill } from '../lib/backfill.ts';
import { intervalSeconds, isUsableBar, mergeNewer, mergeOlder, snapTime, upsertBar, usableBars } from '../lib/candles.ts';
import { wsUrl } from '../lib/endpoint.ts';
import { marketKeyOf } from '../lib/instrument.ts';

export interface MarketSnap {
  key: string;
  info: ContractInfo | null;
  bars: Bar[];
  levels: LevelsResponse | null;
  levelsError?: string | null;
}

const EMPTY_MARKET: MarketSnap = { key: '', info: null, bars: [], levels: null };
const OLDER_PAGE = 1000;
/** Publish several fetched pages together to avoid redrawing the full chart per page. */
const BACKFILL_PUBLISH_PAGES = 5;
const TAIL_PAGE = 300;
const MAX_BARS = 20000;
/**
 * 允许临时多留多少根再裁。
 *
 * 到了上限就一根一根裁是最贵的做法：每来一根新 K 线，最老的那根就换一次，
 * 图表认不出前缀，只能整段重画（两万根 × 4 条序列）。1 分钟图上这就是每分钟一次。
 * 留出一段余量，攒够再一次性裁回去 —— 重画从「每分钟一次」变成「几百分钟一次」。
 */
const TRIM_SLACK = 400;
/** 数据最多留到多少根。超过它就裁回 MAX_BARS */
const KEEP_BARS = MAX_BARS + TRIM_SLACK;
const DEFAULT_CONTRACT = 'BTC_USDT';
/**
 * 服务端每 10 秒推一次心跳，这么久一条消息都没收到就当这条连接已经死了。
 *
 * 留出三拍：偶发丢一两条不会误判，真断了也不会让页面绿着干等太久。
 */
const SILENCE_MS = 30_000;
/** 看门狗多久检查一次 */
const WATCH_EVERY_MS = 5_000;
/**
 * 回到前台时，超过这么久没消息就不等了，直接重连。
 *
 * 一个心跳周期是 10 秒，15 秒还没动静说明至少丢了一拍 —— 这时候再等看门狗那一轮
 * 又要多耗十几秒，而用户就站在屏幕前面看着 K 线不动。
 */
const WAKE_STALE_MS = 15_000;

type Toast = (kind: 'ok' | 'err', title: string, detail?: string) => void;

interface Options {
  contract: string;
  /** 完整品种身份（gate:perp:BTC_USDT）。没有时只按裸符号订阅 */
  instrument?: string;
  interval: string;
  setContract: Dispatch<SetStateAction<string>>;
  onToast: Toast;
}

export function useMarketFeed({ contract, instrument, interval, setContract, onToast }: Options) {
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [market, setMarket] = useState<MarketSnap>(EMPTY_MARKET);
  const [wsAlive, setWsAlive] = useState(false);
  /**
   * 服务端说上游行情断了（gate_down）。
   *
   * 页面自己那条连接是好的，所以那个绿点会一直亮着 —— 用户看到的就是「已连接、
   * 但 K 线不动」。这个标记把这两件事分开：上游一断，顶栏立刻变成「行情断开」，
   * 同时下面那条兜底改用 REST 把尾巴补上。
   */
  const [feedDown, setFeedDown] = useState(false);
  const feedDownRef = useRef(false);
  feedDownRef.current = feedDown;
  const [loading, setLoading] = useState(true);
  const [historyEnd, setHistoryEnd] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef(0);
  const marketSeqRef = useRef(0);
  const pendingLiveRef = useRef<{ key: string; bars: Bar[] }>({ key: '', bars: [] });
  const marketCacheRef = useRef(new Map<string, {
    info: ContractInfo;
    bars: Bar[];
    levels: LevelsResponse | null;
    levelsError?: string | null;
  }>());
  const noMoreOlderRef = useRef(false);
  const pumpingKeyRef = useRef('');
  const pumpGenRef = useRef(0);
  const pumpedKeyRef = useRef('');
  const nopageRetryRef = useRef(0);
  const marketRef = useRef(market);
  const pendingTickerRef = useRef<LiveTicker | null>(null);
  /**
   * 这条连接最后一帧是什么时候。
   *
   * 判活只能看数据，不能看 readyState：代理节点掉线、TUN 黑洞、手机切前后台之后，
   * TCP 常常还举着，状态是 OPEN，但一帧都不来 —— 页面就一直绿着、K 线一直不动。
   */
  const lastMsgAtRef = useRef(0);
  /** 立刻重连的口子：假死看门狗和「回到前台」都从这里叫（见下面那两个 effect） */
  const kickRef = useRef<(() => void) | null>(null);

  const marketKey = marketKeyOf(contract, interval, instrument);
  const isCurrentMarket = useCallback((key: string) => key === marketKey, [marketKey]);

  useEffect(() => {
    marketRef.current = market;
  }, [market]);

  const loadTickers = useCallback(async () => {
    try {
      const list = await jget<Ticker[]>('/api/tickers');
      setTickers(list);
      if (list.length > 0) {
        setContract((current) => list.some((ticker) => ticker.contract === current) ? current : DEFAULT_CONTRACT);
      }
    } catch {
      // A temporary ticker failure does not interrupt the current chart or account state.
    }
  }, [setContract]);

  /**
   * 所有地方必须用同一个键。
   *
   * 以前 loadMarket 用的是裸符号（`BTC_USDT:15m`），而 marketKey 已经带上身份
   * （`gate:perp:BTC_USDT:15m`）—— 于是 App 那句 `market.key === marketKey`
   * 永远不成立，bars 被当成「不是当前品种」一直给空数组，图就是白的。
   */
  const loadMarket = useCallback(async (name: string, timeframe: string) => {
    const key = marketKeyOf(name, timeframe, instrument);
    const sequence = ++marketSeqRef.current;
    pendingLiveRef.current = { key, bars: [] };
    noMoreOlderRef.current = false;
    setHistoryEnd(false);

    const cached = marketCacheRef.current.get(key) ?? null;
    if (cached) {
      const next = { key, ...cached };
      marketRef.current = next;
      setMarket(next);
    }
    setLoading(!cached);

    try {
      const levelsPromise = jget<LevelsResponse>(`/api/levels?contract=${name}&interval=${timeframe}&limit=500`)
        .then((levels) => ({ levels, error: null as string | null }))
        .catch((error: unknown) => ({ levels: null, error: (error as Error).message || '关键位暂不可用' }));
      const [info, candles, levelsResult] = await Promise.all([
        jget<ContractInfo>(`/api/contracts/${name}`),
        jget<{ bars: Bar[] }>(`/api/candles?contract=${name}&interval=${timeframe}&limit=${OLDER_PAGE}`),
        levelsPromise,
      ]);
      if (sequence !== marketSeqRef.current) return;
      const { levels, error: levelsError } = levelsResult;
      const live = pendingLiveRef.current.key === key ? pendingLiveRef.current.bars : [];
      const bars = mergeNewer(usableBars(candles.bars), usableBars(live), KEEP_BARS).bars;
      if (pendingLiveRef.current.key === key) pendingLiveRef.current = { key: '', bars: [] };
      const cache = marketCacheRef.current;
      cache.delete(key);
      cache.set(key, { info, bars, levels, levelsError });
      if (cache.size > 4) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      const next = { key, info, bars, levels, levelsError };
      marketRef.current = next;
      setMarket(next);
    } catch (error) {
      if (sequence === marketSeqRef.current) onToast('err', '行情加载失败', (error as Error).message);
    } finally {
      if (sequence === marketSeqRef.current) setLoading(false);
    }
  }, [onToast, instrument]);

  const loadLevelsOnly = useCallback(async (name: string, timeframe: string) => {
    const key = marketKeyOf(name, timeframe, instrument);
    try {
      const levels = await jget<LevelsResponse>(`/api/levels?contract=${name}&interval=${timeframe}&limit=500`);
      setMarket((current) => current.key === key ? { ...current, levels, levelsError: null } : current);
    } catch (error) {
      setMarket((current) => current.key === key
        ? { ...current, levelsError: (error as Error).message || '关键位暂不可用' }
        : current);
    }
  }, [instrument]);

  const backfillOlder = useCallback(async () => {
    const key = marketRef.current.key;
    if (!key || marketRef.current.bars.length === 0 || !isCurrentMarket(key)) return;
    if (noMoreOlderRef.current || pumpingKeyRef.current === key) return;

    const generation = ++pumpGenRef.current;
    pumpingKeyRef.current = key;
    /**
     * 合约和周期直接从当前状态取，**不能**再从 key 里 split。
     *
     * 键现在带身份（`gate:perp:BTC_USDT:15m`），split(':') 出来第一段是 "gate" ——
     * 于是补历史会去问一个叫 gate 的合约，返回空页，往回拖永远补不出东西。
     */
    const name = contract;
    const timeframe = interval;
    const stale = () => pumpGenRef.current !== generation || marketRef.current.key !== key;
    let failures = 0;
    let pagesSincePublish = 0;
    const publishOlder = (older: Bar[]) => {
      setMarket((current) => {
        if (current.key !== key) return current;
        /**
         * 补历史的容量按 MAX_BARS 算，不按 KEEP_BARS。
         *
         * 按 KEEP_BARS 补会补到 20400，紧接着来一根新 K 线就超过上限、当场整段重画一次 ——
         * 打开页面第一分钟就卡一下，白白把余量吃掉。
         */
        const merged = mergeOlder(current.bars, older, MAX_BARS);
        return merged.bars === current.bars ? current : { ...current, bars: merged.bars };
      });
    };
    setBackfilling(true);

    try {
      const result = await backfill({
        bars: marketRef.current.bars,
        maxBars: MAX_BARS,
        shouldStop: stale,
        onError: () => { failures += 1; },
        fetchPage: async (before) => {
          const page = await jget<{ bars: Bar[]; exhausted?: boolean }>(
            `/api/candles?contract=${name}&interval=${timeframe}&limit=${OLDER_PAGE}&before=${before}`,
          );
          return { bars: usableBars(page.bars), exhausted: page.exhausted === true };
        },
        onPage: (next) => {
          if (stale()) return;
          pagesSincePublish += 1;
          if (pagesSincePublish < BACKFILL_PUBLISH_PAGES) return;
          pagesSincePublish = 0;
          publishOlder(next);
        },
      });
      if (stale()) return;
      publishOlder(result.bars);

      if (result.stopped === 'exhausted' || result.stopped === 'full' || result.pages > 0) {
        nopageRetryRef.current = 0;
      }
      if (result.stopped === 'exhausted') {
        noMoreOlderRef.current = true;
        setHistoryEnd(true);
      } else if (result.stopped === 'full') {
        noMoreOlderRef.current = true;
        onToast('ok', `已加载 ${result.bars.length} 根 K 线`, `本地上限 ${MAX_BARS} 根。要看更早的行情，换更大的周期。`);
      } else if (result.stopped === 'error' && failures > 0) {
        onToast('err', '历史 K 线没拉到', '服务端或交易所没有响应。往回拖一下会重新拉。');
      } else if (result.stopped === 'nopage' || result.stopped === 'pagelimit') {
        if (nopageRetryRef.current < 3) {
          nopageRetryRef.current += 1;
          const wait = 4000 * nopageRetryRef.current;
          const retryGeneration = pumpGenRef.current;
          window.setTimeout(() => {
            if (pumpGenRef.current !== retryGeneration || marketRef.current.key !== key) return;
            void backfillOlder();
          }, wait);
        } else {
          nopageRetryRef.current = 0;
          onToast('err', '历史 K 线拉不动了', '交易所那头连着几次没给新的页。往回拖一下会再试。');
        }
      }
    } finally {
      if (pumpGenRef.current === generation) pumpingKeyRef.current = '';
      setBackfilling(false);
    }
  }, [isCurrentMarket, onToast]);

  const needOlder = useCallback(() => { void backfillOlder(); }, [backfillOlder]);

  const resyncTail = useCallback(async () => {
    const key = marketRef.current.key;
    if (!key || marketRef.current.bars.length === 0 || !isCurrentMarket(key)) return;
    // 和 backfillOlder 同一个理由：键带身份之后不能再 split，直接取当前状态
    const name = contract;
    const timeframe = interval;
    try {
      const page = await jget<{ bars: Bar[] }>(`/api/candles?contract=${name}&interval=${timeframe}&limit=${TAIL_PAGE}`);
      if (marketRef.current.key !== key) return;
      setMarket((current) => {
        if (current.key !== key) return current;
        // 上限用 KEEP_BARS：resync 不该顺手把头部那一根裁掉（那会触发整段重画）
        const merged = mergeNewer(current.bars, usableBars(page.bars), KEEP_BARS);
        return merged.added === 0 && merged.patched === 0 ? current : { ...current, bars: merged.bars };
      });
    } catch {
      // The next synchronization can fill a temporary gap.
    }
  }, [contract, interval, isCurrentMarket]);

  useEffect(() => {
    void loadMarket(contract, interval);
    // loadMarket 的依赖里已经有 instrument：身份到达（配置回来）时会重新加载一次，
    // 否则第一屏拿到的快照键是不带身份的，App 那边会判成「不是当前品种」
  }, [contract, interval, loadMarket]);

  useEffect(() => {
    if (market.key !== marketKey || market.bars.length === 0 || pumpedKeyRef.current === marketKey) return;
    pumpedKeyRef.current = marketKey;
    void backfillOlder();
  }, [market.key, market.bars.length, marketKey, backfillOlder]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadTickers(), 12_000);
    void loadTickers();
    return () => window.clearInterval(timer);
  }, [loadTickers]);

  useEffect(() => {
    const seconds = intervalSeconds(interval);
    const timer = window.setInterval(() => {
      /**
       * 上游断了的时候，每 15 秒就按 REST 的尾巴补一次。
       *
       * 原来只在「最后一根落后三个周期」时才补。行情连着的时候够用，断的时候就太慢了：
       * 15 分钟图上要等 45 分钟，这期间页面还写着「已连接」—— 看上去就是 K 线彻底不动了。
       */
      if (feedDownRef.current) { void resyncTail(); return; }
      const bars = marketRef.current.bars;
      if (bars.length > 0 && Date.now() / 1000 - bars[bars.length - 1]!.time > seconds * 3) {
        void resyncTail();
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [interval, resyncTail]);

  useEffect(() => {
    let disposed = false;
    let retryTimer = 0;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(wsUrl('/ws'));
      wsRef.current = socket;

      socket.onopen = () => {
        // 这条已经被换掉了（假死重连会先让位再关）：迟到的 open 不该再动状态
        if (wsRef.current !== socket) return;
        setWsAlive(true);
        reconnectRef.current = 0;
        lastMsgAtRef.current = Date.now();
        /**
         * 订阅同时带两种写法：contract 给老服务端兜底，
         * instrument 给新服务端（它按身份订阅，换交易所时同名合约不会串）。
         * 认不出来的身份不带，服务端会退回 contract。
         */
        socket.send(JSON.stringify({
          type: 'subscribe',
          contract,
          interval,
          ...(instrument ? { instrument } : {}),
        }));
        void resyncTail();
      };

      socket.onmessage = (event) => {
        if (disposed || wsRef.current !== socket) return;
        // 收到任何一条（含心跳）都算这条连接还活着
        lastMsgAtRef.current = Date.now();
        let message: WsMessage;
        try { message = JSON.parse(event.data) as WsMessage; } catch { return; }
        if (message.type === 'gate_down') {
          setFeedDown(true);
          // 上游断了：立刻用 REST 补一次，别等「落后三个周期」那条兜底慢慢触发
          void resyncTail();
          return;
        }
        if (message.type === 'ticker') {
          if (message.contract === contract) {
            pendingTickerRef.current = message;
            setFeedDown((down) => (down ? false : down));
          }
          return;
        }
        if (message.type !== 'candle' || message.contract !== contract) return;
        setFeedDown((down) => (down ? false : down));

        const incoming = message.bar;
        const key = marketKeyOf(contract, interval, instrument);
        /**
         * 推来的时间可能不是周期起点（Bitget 的「正在走的那根」给的是当前分钟）。
         * 这里再吸附一次：不吸附的话，20:29 的帧会在 5 分钟图里另起一根，
         * 多出来的「幽灵 K 线」让图断续，也把视口和价格轴一起带偏。
         */
        const time = snapTime(Number(incoming.time), intervalSeconds(interval));
        const bar: Bar = {
          time,
          open: incoming.open,
          high: incoming.high,
          low: incoming.low,
          close: incoming.close,
          volume: incoming.volume,
          turnover: incoming.turnover,
        };
        // 推来的帧字段缺失时 Number(undefined) 会变成 NaN。这种根进了图表就是一个
        // 「有时间、没价格」的空槽：横轴占位、画面空白，最新那根被推得越来越靠左。
        if (!isUsableBar(bar)) return;
        const currentMarket = marketRef.current;
        const currentLast = currentMarket.bars[currentMarket.bars.length - 1];
        if (pendingLiveRef.current.key === key
          && (currentMarket.key !== key || !currentLast || bar.time >= currentLast.time)) {
          upsertBar(pendingLiveRef.current.bars, bar, TAIL_PAGE);
        }
        if (currentMarket.key !== key || currentMarket.bars.length === 0) return;

        setMarket((current) => {
          if (current.key !== key || current.bars.length === 0) return current;
          const bars = current.bars.slice();
          const last = bars[bars.length - 1]!;
          if (last.time === bar.time) bars[bars.length - 1] = bar;
          else if (bar.time > last.time) {
            if (bar.time - last.time > intervalSeconds(interval)) void resyncTail();
            bars.push(bar);
            /**
             * 涨过上限 + 余量才裁，一次裁回 MAX_BARS。
             *
             * 这条路以前完全不裁：数组会一路涨到 20001、20002…… 下一次 resyncTail
             * 走 mergeNewer 时又按 20000 裁回，于是「左边那一根」每分钟变一次，
             * 图表跟着整段重画一次。裁在这里，且留出余量，长度几百分钟才动一次。
             */
            if (bars.length > KEEP_BARS) bars.splice(0, bars.length - MAX_BARS);
          } else {
            return current;
          }
          return { ...current, bars };
        });
        if (incoming.closed) void loadLevelsOnly(contract, interval);
      };

      socket.onclose = () => {
        // 假死重连会先让位再关，那条迟到的 close 不该再排一次重连
        if (wsRef.current !== socket) return;
        wsRef.current = null;
        setWsAlive(false);
        if (disposed) return;
        const delay = Math.min(15_000, 600 * 2 ** reconnectRef.current++);
        retryTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => { try { socket.close(); } catch { /* 已经断了 */ } };
    };

    /**
     * 立刻重连，不等 onclose。
     *
     * 半开的连接（对端不回声、TCP 还举着）根本不会发 close，等它就是等用户刷新页面。
     * 先把 wsRef 让出来、清掉退避，再尽力关一次，然后自己接上 —— 和服务端 abandon()
     * 同一个道理：判活的标准是「还有没有数据」，不是「有没有关」。
     */
    const kick = () => {
      if (disposed) return;
      const socket = wsRef.current;
      wsRef.current = null;
      reconnectRef.current = 0;
      window.clearTimeout(retryTimer);
      try { socket?.close(); } catch { /* 已经断了 */ }
      connect();
    };
    kickRef.current = kick;

    connect();
    return () => {
      disposed = true;
      kickRef.current = null;
      window.clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // instrument 进依赖：换交易所时同名合约是另一个品种，必须重新订阅
  }, [contract, instrument, interval, loadLevelsOnly, resyncTail]);

  /**
   * 假死看门狗：连着但一帧不来，自己放掉重连。
   *
   * 半开的连接不会发 close，onclose 那条重连路根本不会被触发。没有这一条，用户看到的
   * 就是「顶栏写着行情已连接、K 线却停在切走之前」，除了刷新没有别的出路。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMsgAtRef.current < SILENCE_MS) return;
      kickRef.current?.();
    }, WATCH_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * 回到前台先把连接验一遍。
   *
   * 手机切到别的 App 再回来、电脑锁屏、显示器休眠，这几种情况下连接经常已经死了，
   * 而浏览器不会补发 close。这里不等看门狗：连不上就当场重连，再用 REST 把尾巴补上 ——
   * 切走这段时间的 K 线不该等下一轮兜底才出现。
   */
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      const socket = wsRef.current;
      // 正在握手就别打断：它要么马上 open（这时会把「最后消息」刷新成现在），
      // 要么失败后由 onclose 自己排重连。这时候再起一条只会把退避重置成 0。
      if (!socket || socket.readyState === WebSocket.CONNECTING) {
        if (!socket) kickRef.current?.();
        void resyncTail();
        return;
      }
      const stale = Date.now() - lastMsgAtRef.current > WAKE_STALE_MS;
      if (stale || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
        kickRef.current?.();
      }
      // 不管连接要不要重建，先把切走这段时间的尾巴补上 —— REST 这条路本来就是好的
      void resyncTail();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [resyncTail]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const latest = pendingTickerRef.current;
      if (!latest) return;
      pendingTickerRef.current = null;
      setTickers((current) => {
        const index = current.findIndex((ticker) => ticker.contract === latest.contract);
        if (index < 0) return current;
        const next = current.slice();
        next[index] = {
          ...next[index]!,
          last: latest.last,
          mark: latest.mark,
          change24h: latest.change24h,
          fundingRate: latest.fundingRate,
          volume24hUsd: latest.volume24hUsd,
        };
        return next;
      });
    }, 300);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void loadLevelsOnly(contract, interval), 45_000);
    return () => window.clearInterval(timer);
  }, [contract, interval, loadLevelsOnly]);

  /**
   * 顶栏那颗点：页面这条连接通着、并且服务端没说上游断了，才算「行情已连接」。
   * 只看前者的话，上游掉线时页面会一直绿着，比直接断线更误导。
   */
  return {
    tickers,
    market,
    wsAlive: wsAlive && !feedDown,
    feedDown,
    loading,
    historyEnd,
    backfilling,
    needOlder,
    resyncTail,
  };
}
