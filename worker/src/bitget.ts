import { ApiError } from './errors';
import { request, toB64, toHex } from './http';
import { ceilSizeToStep, floorSizeToStep } from './sizing';
import type {
  Account, Bar, Client, ContractInfo, Direction, Env, OpenOrder, OrderInput,
  Position, PriceOrder, TickerRow, TriggerInput,
} from './types';

/**
 * Bitget v2 · USDT 永续。
 *
 * 两个口径和服务端一样，写在这里免得出错：
 *   1. **size 是币，不是张**。接口里的 size / minTradeNum / maxOrderQty 全是币本位，
 *      页面上说的「张」要乘 sizeMultiplier 才能发出去，回来的要除回去。
 *   2. **签名**：timestamp + METHOD + path + (GET ? '?' + 排序后的原始 query : body)，
 *      HMAC-SHA256 → base64。query 必须按 key 升序，而且签名里用的是**没编码**的原文，
 *      编码只用在 URL 上。两边不一致的话交易所只会回「签名错误」。
 *
 * 模拟盘不换域名：同一个 api.bitget.com，靠 PAPTRADING: 1 切到模拟账户。
 */

const BASE = 'https://api.bitget.com';
const PREFIX = '/api/v2';
const PRODUCT = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';
const LIMIT = 1000;
/** /candles 一次最多给 90 天窗口，按周期换算成根数 */
const WINDOW_DAY_SECONDS = 90 * 86_400;

const INTERVALS: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '4h': '4H', '1d': '1D',
};
const STEP_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14_400, '1d': 86_400,
};

export interface BitgetConfig {
  env: Env;
  key: string;
  secret: string;
  passphrase: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fixed = (v: number, places: number): string => v.toFixed(Math.max(0, Math.min(12, places)));

/** BTC_USDT ↔ BTCUSDT：页面上一直用前者，Bitget 只认后者 */
const symbolOf = (name: string): string => name.replace('_', '');
const nameOf = (symbol: string): string => {
  const s = String(symbol || '');
  return s.includes('_') ? s : s.endsWith('USDT') ? s.slice(0, -4) + '_USDT' : s;
};

const HINTS: Record<string, string> = {
  '40001': '签名不对：SECRET 或 PASSPHRASE 粘错了',
  '40006': '请求时间差太多，先校准系统时间',
  '40009': '这个合约/参数在 Bitget 上不适用',
  '40011': '仓位模式不对（单向/双向），先到交易所里确认',
  '40017': '参数不对，交易所拒绝了这一单',
  '40018': '可用余额不够',
  '40019': '这张单已经不在了',
  '40020': '张数换算后的数量太小，低于最小下单量',
  '40725': '重复下单被挡下（同一个 clientOid）',
  '43001': '没有仓位可平',
  '43012': '这把密钥没有交易权限',
};

export function bitgetClient(cfg: BitgetConfig): Client {
  const hasKeys = Boolean(cfg.key && cfg.secret && cfg.passphrase);
  let table: { at: number; rows: ContractInfo[] } | null = null;
  /** 单向 / 双向：决定 side 和 tradeSide 怎么填，缓存一会儿别每单问一次 */
  let mode: { at: number; hedge: boolean } | null = null;

  async function sign(ts: string, method: string, path: string, query: string, body: string): Promise<string> {
    const payload = ts + method + path + (method === 'GET' ? (query ? '?' + query : '') : body);
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(cfg.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toB64(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(payload)));
  }

  function encodeQuery(params: Record<string, string | number | boolean | undefined>): { url: string; raw: string } {
    const entries: [string, string][] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === '') continue;
      entries.push([k, String(v)]);
    }
    // 顺序必须固定：签名和 URL 各拼一次，两次顺序不一样就算不出同一个签名
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return {
      url: entries.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'),
      raw: entries.map(([k, v]) => k + '=' + v).join('&'),
    };
  }

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    body?: Record<string, unknown>,
    opts: { private?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const isPrivate = opts.private === true;
    if (isPrivate && !hasKeys) {
      throw new ApiError(401, 'NO_KEYS', 'Worker 上没有配置 Bitget 的 KEY / SECRET / PASSPHRASE（wrangler secret put）');
    }
    const q = encodeQuery(params);
    const query = method === 'GET' ? q.url : '';
    const bodyStr = method === 'POST' && body ? JSON.stringify(body) : '';
    const url = BASE + path + (query ? '?' + query : '');

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (bodyStr) headers['Content-Type'] = 'application/json';
    if (cfg.env === 'testnet') headers.PAPTRADING = '1';
    if (isPrivate) {
      const ts = String(Date.now());
      headers['ACCESS-KEY'] = cfg.key;
      headers['ACCESS-SIGN'] = await sign(ts, method, path, q.raw, bodyStr);
      headers['ACCESS-TIMESTAMP'] = ts;
      headers['ACCESS-PASSPHRASE'] = cfg.passphrase;
    }

    const r = await request(url, { method, headers, body: bodyStr || undefined }, opts.timeoutMs ?? 15_000);
    let data: any = null;
    try { data = r.text ? JSON.parse(r.text) : null; } catch { data = null; }
    const code = String(data?.code ?? '');
    if (!r.ok || (isPrivate && code && code !== '00000') || (!isPrivate && r.status >= 400)) {
      const label = code || 'HTTP_' + r.status;
      const detail = HINTS[label] ?? String(data?.msg ?? 'Bitget 返回 HTTP ' + r.status);
      throw new ApiError(r.status === 200 ? 400 : r.status, label, detail);
    }
    return (data?.data ?? null) as T;
  }

  async function contracts(): Promise<ContractInfo[]> {
    if (table && Date.now() - table.at < 60_000) return table.rows;
    const raw = await call<any[]>('GET', '/mix/market/contracts', { productType: PRODUCT }, undefined, { timeoutMs: 25_000 });
    const rows: ContractInfo[] = (raw ?? []).map((c) => {
      const mult = num(c.sizeMultiplier) || 1;
      const pricePlace = Math.round(num(c.pricePlace));
      const sizePlace = Math.min(12, Math.max(0, Math.round(num(c.volumePlace))));
      const sizeStep = Math.pow(10, -sizePlace) / mult;
      const minSize = num(c.minTradeNum) / mult;
      const maxSize = (num(c.maxOrderQty) || num(c.maxMarketOrderQty)) / mult;
      return {
        name: nameOf(c.symbol),
        multiplier: mult,
        // 把交易所的币数量最小值/精度换成页面统一使用的张数与张数步进
        sizeMin: minSize > 0 ? ceilSizeToStep(minSize, sizeStep) : sizeStep,
        sizeStep,
        sizeMax: maxSize > 0 ? floorSizeToStep(maxSize, sizeStep) : 0,
        sizePlace,
        priceRound: pricePlace >= 0 ? Math.pow(10, -pricePlace) : 0,
        leverageMin: num(c.minLever) || 1,
        leverageMax: num(c.maxLever) || 1,
        price: num(c.lastPr),
        markPrice: num(c.markPrice ?? c.indexPrice ?? c.lastPr),
        fundingRate: num(c.fundingRate),
        fundingInterval: num(c.fundInterval) || 8,
        takerFee: num(c.takerFeeRate),
        makerFee: num(c.makerFeeRate),
        status: String(c.symbolStatus ?? ''),
        tradable: String(c.symbolStatus ?? 'normal') === 'normal',
      };
    });
    table = { at: Date.now(), rows };
    return rows;
  }

  async function multiplierOf(name: string): Promise<number> {
    const list = await contracts().catch(() => [] as ContractInfo[]);
    return list.find((c) => c.name === name)?.multiplier ?? 0;
  }

  async function hedgeMode(): Promise<boolean> {
    if (mode && Date.now() - mode.at < 60_000) return mode.hedge;
    const data = await call<any[]>('GET', '/mix/account/accounts', { productType: PRODUCT }, undefined, { private: true }).catch(() => [] as any[]);
    const hedge = String((data ?? []).find((a) => String(a.marginCoin) === MARGIN_COIN)?.posMode ?? '') === 'hedge_mode';
    mode = { at: Date.now(), hedge };
    return hedge;
  }

  return {
    id: 'bitget',
    label: 'Bitget',
    intervals: Object.keys(INTERVALS),
    restBaseUrl: BASE,

    contracts,

    async tickers() {
      const [raw, list] = await Promise.all([
        call<any[]>('GET', '/mix/market/tickers', { productType: PRODUCT }, undefined, { timeoutMs: 25_000 }),
        contracts().catch(() => [] as ContractInfo[]),
      ]);
      const round = new Map(list.map((c) => [c.name, c.priceRound]));
      return (raw ?? [])
        .map((t): TickerRow | null => {
          const name = nameOf(t.symbol);
          const last = num(t.lastPr);
          if (!(last > 0)) return null;
          return {
            contract: name,
            last,
            mark: num(t.markPrice) || last,
            change24h: num(t.change24h) * 100,
            volume24hUsd: num(t.quoteVolume),
            fundingRate: num(t.fundingRate),
            priceRound: round.get(name) ?? 0,
            tradable: true,
          };
        })
        .filter((x): x is TickerRow => x !== null)
        .sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    },

    async candles(name, interval, limit, to) {
      const g = INTERVALS[interval];
      if (!g) throw new ApiError(400, 'NO_INTERVAL', 'Bitget 没有 ' + interval + ' 这个周期（支持 ' + Object.keys(INTERVALS).join(' / ') + '）');
      const step = STEP_SECONDS[interval] ?? 900;
      const cap = Math.min(Math.max(1, Math.round(limit)), LIMIT);
      const perPage = Math.min(cap, Math.max(1, Math.floor(WINDOW_DAY_SECONDS / step)));
      const out: Bar[] = [];
      const seen = new Set<number>();
      let endMs = to && to > 0 ? Math.round(to) * 1000 : Date.now();
      for (let guard = 0; guard < 8 && out.length < cap; guard += 1) {
        const rows = await call<unknown[][]>('GET', '/mix/market/candles', {
          symbol: symbolOf(name), productType: PRODUCT, granularity: g,
          limit: Math.min(perPage, cap - out.length), endTime: endMs,
        }, undefined, { timeoutMs: 25_000, });
        if (!rows || rows.length === 0) break;
        let oldest = endMs;
        for (const row of rows) {
          const t = Math.round(num(row[0]) / 1000);
          if (!t || seen.has(t)) continue;
          seen.add(t);
          oldest = Math.min(oldest, t * 1000);
          out.push({ time: t, open: num(row[1]), high: num(row[2]), low: num(row[3]), close: num(row[4]), volume: num(row[5]) });
        }
        if (rows.length < perPage) break;
        endMs = oldest - step * 1000;
      }
      return out.sort((a, b) => a.time - b.time).slice(-cap);
    },

    async account() {
      const data = await call<any[]>('GET', '/mix/account/accounts', { productType: PRODUCT }, undefined, { private: true });
      const a = (data ?? []).find((x) => String(x.marginCoin) === MARGIN_COIN) ?? (data ?? [])[0] ?? {};
      return {
        total: num(a.accountEquity),
        available: num(a.available),
        unrealisedPnl: num(a.unrealizedPL),
        currency: MARGIN_COIN,
      };
    },

    async positions() {
      const data = await call<any[]>('GET', '/mix/position/allPosition', { productType: PRODUCT, marginCoin: MARGIN_COIN }, undefined, { private: true });
      const out: Position[] = [];
      for (const p of data ?? []) {
        const name = nameOf(p.symbol);
        const mult = await multiplierOf(name).catch(() => 0);
        if (!(mult > 0)) continue;
        const coin = num(p.total);
        if (!(Math.abs(coin) > 0)) continue;
        const hold = String(p.holdSide ?? '').toLowerCase();
        const hedge = String(p.posMode ?? '') === 'hedge_mode';
        const short = hold === 'short' || (hold !== 'long' && coin < 0);
        out.push({
          contract: name,
          size: Math.abs(coin) / mult,
          direction: short ? 'short' : 'long',
          leverage: num(p.leverage) || 1,
          entryPrice: num(p.openPriceAvg ?? p.openAvgPrice ?? p.averageOpenPrice),
          markPrice: num(p.markPrice),
          liqPrice: num(p.liquidationPrice),
          // 单向持仓时 Bitget 只给一个总和：多空的未实现盈亏合在一起
          unrealisedPnl: num(p.unrealizedPL),
          value: Math.abs(coin) * num(p.markPrice),
          mode: hedge ? (short ? 'dual_short' : 'dual_long') : 'single',
          multiplier: mult,
        });
      }
      return out;
    },

    async orders() {
      const data = await call<any>('GET', '/mix/order/orders-pending', { productType: PRODUCT }, undefined, { private: true });
      const list = (data as any)?.entrustedList ?? [];
      const out: OpenOrder[] = [];
      for (const raw of list) {
        const name = nameOf(raw.symbol);
        const mult = await multiplierOf(name).catch(() => 0);
        const coin = num(raw.size);
        const filled = num(raw.baseVolume ?? raw.cumExecQty);
        const side = String(raw.side ?? '').toLowerCase();
        const tradeSide = String(raw.tradeSide ?? '').toLowerCase();
        // 双向持仓下 side 表示「哪一边」，平仓时方向要反着读
        const effective = tradeSide === 'close' ? (side === 'buy' ? 'sell' : 'buy') : side;
        const signed = (effective === 'sell' ? -1 : 1) * (mult > 0 ? coin / mult : coin);
        const left = Math.max(0, coin - filled);
        out.push({
          id: String(raw.orderId ?? ''),
          contract: name,
          size: signed,
          left: mult > 0 ? left / mult : left,
          price: num(raw.price),
          fillPrice: num(raw.priceAvg),
          status: String(raw.status ?? 'live') === 'filled' ? 'finished' : 'open',
          reduceOnly: tradeSide === 'close' || String(raw.reduceOnly ?? '').toUpperCase() === 'YES',
          createTime: Math.round(num(raw.cTime ?? raw.uTime) / 1000),
          tif: String(raw.force ?? 'gtc').toLowerCase(),
        });
      }
      return out;
    },

    async triggers() {
      const data = await call<any>('GET', '/mix/order/orders-plan-pending', { productType: PRODUCT, planType: 'profit_loss' }, undefined, { private: true });
      const list = (data as any)?.entrustedList ?? [];
      const out: PriceOrder[] = [];
      for (const raw of list) {
        const name = nameOf(raw.symbol);
        const mult = await multiplierOf(name).catch(() => 0);
        const hold = String(raw.posSide ?? raw.holdSide ?? '').toLowerCase();
        const side = String(raw.side ?? '').toLowerCase();
        const dir: Direction = hold === 'short' ? 'short' : hold === 'long' ? 'long' : side === 'sell' ? 'long' : 'short';
        const plan = String(raw.planType ?? '').toLowerCase();
        const isLoss = plan === 'pos_loss';
        // Gate 的 rule：1 = 价格 >= 触发价，2 = 价格 <= 触发价
        const rule = (dir === 'long') === isLoss ? 2 : 1;
        out.push({
          id: String(raw.orderId ?? ''),
          contract: name,
          direction: dir,
          triggerPrice: num(raw.triggerPrice),
          triggerRule: rule,
          size: mult > 0 ? num(raw.size) / mult : num(raw.size),
          protective: true,
          reduceOnly: true,
          closeAll: !(num(raw.size) > 0),
          createTime: Math.round(num(raw.cTime ?? raw.uTime) / 1000),
          // Bitget 的持仓止盈止损不会自己过期
          expiresAt: 0,
        });
      }
      return out;
    },

    async placeOrder(o: OrderInput) {
      const list = await contracts().catch(() => [] as ContractInfo[]);
      const info = list.find((c) => c.name === o.contract);
      const mult = info?.multiplier ?? 0;
      if (!(mult > 0) || !info) throw new ApiError(400, 'NO_CONTRACT', '没有 ' + o.contract + ' 的合约参数，先刷新一次行情');
      const isMarket = !(o.price > 0);
      const hedge = await hedgeMode();
      const body: Record<string, unknown> = {
        symbol: symbolOf(o.contract),
        productType: PRODUCT,
        marginCoin: MARGIN_COIN,
        size: fixed(o.size * mult, info.sizePlace ?? 4),
        side: o.side === 'long' ? 'buy' : 'sell',
        orderType: isMarket ? 'market' : 'limit',
      };
      if (!isMarket) {
        const list = await contracts().catch(() => [] as ContractInfo[]);
        const round = list.find((c) => c.name === o.contract)?.priceRound ?? 0;
        const places = round > 0 ? Math.max(0, Math.ceil(-Math.log10(round))) : 2;
        body.price = fixed(o.price, places);
        body.force = o.tif === 'ioc' ? 'ioc' : 'gtc';
      }
      if (hedge) {
        body.tradeSide = o.reduceOnly ? 'close' : 'open';
      } else if (o.reduceOnly) {
        // 单向持仓没有 tradeSide，减仓只能靠 reduceOnly
        body.reduceOnly = 'YES';
        body.side = o.side === 'long' ? 'sell' : 'buy';
      }
      const data = await call<any>('POST', '/mix/order/place-order', {}, body, { private: true });
      const id = String(data?.orderId ?? '');
      if (!id) throw new ApiError(502, 'BAD_RESPONSE', 'Bitget 没有回委托号');
      return { id, status: 'open', fillPrice: 0 };
    },

    async amendOrder(id, o) {
      // Bitget 改单量也用币单位，和下单接口保持同一套张→币换算。
      let newSize: string | undefined;
      if (o.size !== undefined) {
        const open = await this.orders().catch(() => [] as OpenOrder[]);
        const current = open.find((x) => x.id === id);
        const info = current ? (await contracts()).find((x) => x.name === current.contract) : undefined;
        if (!info) throw new ApiError(400, 'NO_CONTRACT', '找不到这张单对应的合约参数');
        newSize = fixed(o.size * info.multiplier, info.sizePlace ?? 4);
      }
      await call('POST', '/mix/order/modify-order', {}, {
        orderId: id,
        newSize,
        newPrice: o.price !== undefined ? String(o.price) : undefined,
      } as Record<string, unknown>, { private: true });
      return { id };
    },

    async cancelOrder(id) {
      const open = await this.orders().catch(() => [] as OpenOrder[]);
      const hit = open.find((x) => x.id === id);
      if (!hit) throw new ApiError(404, 'ORDER_NOT_FOUND', '找不到这张委托，可能已经成交或撤掉了');
      await call('POST', '/mix/order/cancel-order', {}, {
        symbol: symbolOf(hit.contract), productType: PRODUCT, marginCoin: MARGIN_COIN, orderId: id,
      }, { private: true });
      return { id };
    },

    async placeTrigger(t: TriggerInput) {
      const list = await contracts().catch(() => [] as ContractInfo[]);
      const info = list.find((c) => c.name === t.contract);
      if (!info) throw new ApiError(400, 'NO_CONTRACT', '没有 ' + t.contract + ' 的合约参数');
      if (!(t.price > 0)) throw new ApiError(400, 'BAD_INPUT', '触发价不合法');
      const isLong = t.direction === 'long';
      const isLoss = t.role === 'stop';
      const hedge = await hedgeMode();
      const places = info.priceRound > 0 ? Math.max(0, Math.ceil(-Math.log10(info.priceRound))) : 2;
      const body: Record<string, unknown> = {
        symbol: symbolOf(t.contract),
        productType: PRODUCT,
        marginCoin: MARGIN_COIN,
        planType: isLoss ? 'pos_loss' : 'pos_profit',
        triggerPrice: fixed(t.price, places),
        // 和 Gate 的 price_type=0（最新成交价）对齐
        triggerType: 'fill_price',
        executePrice: '0',
        // 单向持仓时 holdSide 用 buy/sell，双向直接用 long/short
        holdSide: hedge ? t.direction : (isLong ? 'buy' : 'sell'),
      };
      // 张数：按当前持仓全量平（持仓止盈止损本来就是「平这一边」）
      const mine = (await this.positions().catch(() => [] as Position[])).find((p) => p.contract === t.contract && p.direction === t.direction);
      if (mine && info.multiplier > 0) body.size = fixed(mine.size * info.multiplier, info.sizePlace ?? 4);
      const data = await call<any>('POST', '/mix/order/place-tpsl-order', {}, body, { private: true });
      const id = String(data?.orderId ?? '');
      if (!id) throw new ApiError(502, 'BAD_RESPONSE', 'Bitget 没有回止盈止损单号');
      return { id };
    },

    async cancelTrigger(id) {
      await call('POST', '/mix/order/cancel-plan-order', {}, {
        orderIdList: [{ orderId: id }], productType: PRODUCT,
      }, { private: true });
      return { id };
    },

    async setLeverage(name, leverage, mode_) {
      const symbol = symbolOf(name);
      await call('POST', '/mix/account/set-margin-mode', {}, {
        symbol, productType: PRODUCT, marginCoin: MARGIN_COIN,
        marginMode: mode_ === 'cross' ? 'crossed' : 'isolated',
      }, { private: true }).catch(() => undefined);
      await call('POST', '/mix/account/set-leverage', {}, {
        symbol, productType: PRODUCT, marginCoin: MARGIN_COIN, leverage: String(Math.round(leverage)),
      }, { private: true });
    },

    async marketClose(name, direction, size) {
      const list = await contracts().catch(() => [] as ContractInfo[]);
      const info = list.find((c) => c.name === name);
      const mult = info?.multiplier ?? 0;
      if (!(mult > 0) || !info) throw new ApiError(400, 'NO_CONTRACT', '没有 ' + name + ' 的合约参数');
      const hedge = await hedgeMode();
      const body: Record<string, unknown> = {
        symbol: symbolOf(name),
        productType: PRODUCT,
        marginCoin: MARGIN_COIN,
        size: fixed(size * mult, info.sizePlace ?? 4),
        // 平仓：多单卖出、空单买入
        side: direction === 'long' ? 'sell' : 'buy',
        orderType: 'market',
      };
      if (hedge) body.tradeSide = 'close';
      else body.reduceOnly = 'YES';
      const data = await call<any>('POST', '/mix/order/place-order', {}, body, { private: true });
      return { id: String(data?.orderId ?? ''), status: 'open' };
    },
  };
}
