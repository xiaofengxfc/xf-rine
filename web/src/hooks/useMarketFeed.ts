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
const DEFAULT_CONTRACT = 'BTC_USDT';

type Toast = (kind: 'ok' | 'err', title: string, detail?: string) => void;

interface Options {
  contract: string;
  interval: string;
  setContract: Dispatch<SetStateAction<string>>;
  onToast: Toast;
}

export function useMarketFeed({ contract, interval, setContract, onToast }: Options) {
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

  const marketKey = `${contract}:${interval}`;
  const isCurrentMarket = useCallback((key: string) => key === `${contract}:${interval}`, [contract, interval]);

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

  const loadMarket = useCallback(async (name: string, timeframe: string) => {
    const key = `${name}:${timeframe}`;
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
      const bars = mergeNewer(usableBars(candles.bars), usableBars(live), MAX_BARS).bars;
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
  }, [onToast]);

  const loadLevelsOnly = useCallback(async (name: string, timeframe: string) => {
    const key = `${name}:${timeframe}`;
    try {
      const levels = await jget<LevelsResponse>(`/api/levels?contract=${name}&interval=${timeframe}&limit=500`);
      setMarket((current) => current.key === key ? { ...current, levels, levelsError: null } : current);
    } catch (error) {
      setMarket((current) => current.key === key
        ? { ...current, levelsError: (error as Error).message || '关键位暂不可用' }
        : current);
    }
  }, []);

  const backfillOlder = useCallback(async () => {
    const key = marketRef.current.key;
    if (!key || marketRef.current.bars.length === 0 || !isCurrentMarket(key)) return;
    if (noMoreOlderRef.current || pumpingKeyRef.current === key) return;

    const generation = ++pumpGenRef.current;
    pumpingKeyRef.current = key;
    const [name, timeframe] = key.split(':') as [string, string];
    const stale = () => pumpGenRef.current !== generation || marketRef.current.key !== key;
    let failures = 0;
    let pagesSincePublish = 0;
    const publishOlder = (older: Bar[]) => {
      setMarket((current) => {
        if (current.key !== key) return current;
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
    const [name, timeframe] = key.split(':') as [string, string];
    try {
      const page = await jget<{ bars: Bar[] }>(`/api/candles?contract=${name}&interval=${timeframe}&limit=${TAIL_PAGE}`);
      if (marketRef.current.key !== key) return;
      setMarket((current) => {
        if (current.key !== key) return current;
        const merged = mergeNewer(current.bars, usableBars(page.bars), MAX_BARS);
        return merged.added === 0 && merged.patched === 0 ? current : { ...current, bars: merged.bars };
      });
    } catch {
      // The next synchronization can fill a temporary gap.
    }
  }, [isCurrentMarket]);

  useEffect(() => {
    void loadMarket(contract, interval);
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
        setWsAlive(true);
        reconnectRef.current = 0;
        socket.send(JSON.stringify({ type: 'subscribe', contract, interval }));
        void resyncTail();
      };

      socket.onmessage = (event) => {
        if (disposed) return;
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
        const key = `${contract}:${interval}`;
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
             * 推到上限就得把最老的挤掉。
             *
             * 这条路以前不裁：数组会一路涨到 MAX_BARS + 1、+2…… 下一次 resyncTail/补历史
             * 走 mergeNewer 时又按上限裁回 20000，于是「左边那一根」每分钟变一次，
             * 图表跟着整段重画一次。裁在这里，长度就一直是稳的。
             */
            if (bars.length > MAX_BARS) bars.splice(0, bars.length - MAX_BARS);
          } else {
            return current;
          }
          return { ...current, bars };
        });
        if (incoming.closed) void loadLevelsOnly(contract, interval);
      };

      socket.onclose = () => {
        setWsAlive(false);
        if (disposed) return;
        const delay = Math.min(15_000, 600 * 2 ** reconnectRef.current++);
        retryTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [contract, interval, loadLevelsOnly, resyncTail]);

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
