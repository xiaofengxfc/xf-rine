import { ApiError } from './errors';
import { parseBigInts, request, toHex } from './http';
import { ceilSizeToStep } from './sizing';
import type {
  Account, Bar, Client, ContractInfo, Direction, Env, OpenOrder, OrderInput,
  Position, PriceOrder, TickerRow, TriggerInput,
} from './types';

/**
 * Gate 永续（USDT 结算）。
 *
 * 签名口径和服务端 server/src/gate/rest.ts 完全一致：
 *   SIGN = HMAC_SHA512(secret, method \n path \n query \n sha512(body) \n ts)
 * 这几个换行一个都不能少，顺序也不能变 —— 少一行交易所只会回一句 401。
 *
 * 行情永远打主网：测试网的行情是编造的历史数据，不能拿来做技术分析。
 * 账户和交易才跟着 env 走。
 */

const LIVE = 'https://api.gateio.ws';
const TEST = 'https://api-testnet.gateapi.io';
const PREFIX = '/api/v4';

const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d'];

export interface GateConfig {
  env: Env;
  key: string;
  secret: string;
}

/** 交易所的英文报错翻成人话，页面直接把 detail 显示出来 */
const HINTS: Record<string, string> = {
  INVALID_KEY: '密钥无效，或者这把密钥没有合约权限',
  INVALID_SIGNATURE: '签名不对：多半是 SECRET 粘错了一位',
  REQUEST_EXPIRED: '请求时间和交易所差太多，先校准系统时间',
  FORBIDDEN: '这把密钥没有这个权限（下单需要「合约交易 · 读写」）',
  READ_ONLY: '这把密钥是只读的，下单会被拒',
  CONTRACT_NOT_FOUND: '没有这个合约：测试网只上架了几十个',
  ORDER_NOT_FOUND: '这张单已经不在了（可能已经成交或被撤）',
  INSUFFICIENT_AVAILABLE: '可用余额不够',
  POSITION_NOT_FOUND: '这个合约上没有持仓',
  TOO_MANY_REQUESTS: '请求太密，等一秒再试',
};

function hintOf(body: any, status: number): string {
  const label = String(body?.label ?? body?.message ?? '');
  if (HINTS[label]) return HINTS[label]!;
  if (label) return label + (body?.message ? '：' + body.message : '');
  return 'Gate 返回 HTTP ' + status;
}

async function hmacSha512Hex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

async function sha512Hex(msg: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-512', new TextEncoder().encode(msg)));
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.join('&');
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function gateClient(cfg: GateConfig): Client {
  const pv = cfg.key && cfg.secret;
  const privateBase = cfg.env === 'testnet' ? TEST : LIVE;

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    body?: unknown,
    opts: { private?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const isPrivate = opts.private === true;
    if (isPrivate && !pv) {
      throw new ApiError(401, 'NO_KEYS', 'Worker 上没有配置 Gate 的 KEY / SECRET（wrangler secret put）');
    }
    // 交易参数放在 query 上的接口（改杠杆）也要拼进签名，不能只给 GET 拼
    const query = buildQuery(params);
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const fullPath = PREFIX + path;
    const url = (isPrivate ? privateBase : LIVE) + fullPath + (query ? '?' + query : '');

    const headers: Record<string, string> = { Accept: 'application/json', 'X-Gate-Size-Decimal': '1' };
    if (bodyStr) headers['Content-Type'] = 'application/json';
    if (isPrivate) {
      const ts = String(Math.floor(Date.now() / 1000));
      const payload = method + '\n' + fullPath + '\n' + query + '\n' + (await sha512Hex(bodyStr)) + '\n' + ts;
      headers.KEY = cfg.key;
      headers.Timestamp = ts;
      headers.SIGN = await hmacSha512Hex(cfg.secret, payload);
    }

    const r = await request(url, { method, headers, body: bodyStr || undefined }, opts.timeoutMs ?? 15_000);
    let data: any = null;
    try { data = r.text ? parseBigInts(r.text) : null; } catch { data = null; }
    if (!r.ok) {
      const status = r.status === 200 ? 400 : r.status;
      throw new ApiError(status, String(data?.label ?? 'HTTP_' + status), hintOf(data, r.status));
    }
    return data as T;
  }

  /** 合约表缓存：行情和下单都要乘数，一次拉一遍别每 12 秒重拉 */
  let table: { at: number; rows: ContractInfo[] } | null = null;
  async function contracts(): Promise<ContractInfo[]> {
    if (table && Date.now() - table.at < 60_000) return table.rows;
    const raw = await call<any[]>('GET', '/futures/usdt/contracts', {}, undefined, { timeoutMs: 25_000 });
    const rows: ContractInfo[] = (raw ?? []).map((c) => {
      const minText = String(c.order_size_min ?? '');
      const places = /\.(\d+)/.exec(minText)?.[1]?.length ?? 0;
      const decimalEnabled = c.enable_decimal === true || String(c.enable_decimal) === 'true';
      const sizeStep = decimalEnabled ? Math.pow(10, -Math.min(12, Math.max(1, places))) : 1;
      const minSize = num(c.order_size_min) > 0 ? num(c.order_size_min) : sizeStep;
      return {
        name: String(c.name),
        multiplier: num(c.quanto_multiplier),
        sizeMin: ceilSizeToStep(minSize, sizeStep),
        sizeStep,
        sizeMax: num(c.order_size_max),
        priceRound: num(c.order_price_round),
        leverageMin: num(c.leverage_min) || 1,
        leverageMax: num(c.leverage_max) || 1,
        price: num(c.last_price),
        markPrice: num(c.mark_price),
        fundingRate: num(c.funding_rate),
        fundingInterval: num(c.funding_interval) || 28_800,
        takerFee: num(c.taker_fee_rate),
        makerFee: num(c.maker_fee_rate),
        status: String(c.status ?? ''),
        tradable: c.status !== 'delisted',
      };
    });
    table = { at: Date.now(), rows };
    return rows;
  }

  return {
    id: 'gate',
    label: 'Gate',
    intervals: INTERVALS,
    restBaseUrl: privateBase,

    contracts,

    async tickers() {
      const [raw, list] = await Promise.all([
        call<any[]>('GET', '/futures/usdt/tickers', {}, undefined, { timeoutMs: 25_000 }),
        contracts().catch(() => [] as ContractInfo[]),
      ]);
      const round = new Map(list.map((c) => [c.name, c.priceRound]));
      return (raw ?? [])
        .filter((t) => num(t.last) > 0)
        .map((t): TickerRow => ({
          contract: String(t.contract),
          last: num(t.last),
          mark: num(t.mark_price),
          change24h: num(t.change_percentage),
          volume24hUsd: num(t.volume_24h_quote),
          fundingRate: num(t.funding_rate),
          priceRound: round.get(String(t.contract)) ?? 0,
          tradable: true,
        }))
        .sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    },

    async candles(name, interval, limit, to) {
      const params: Record<string, string | number> = { contract: name, interval, limit: Math.max(1, Math.min(1000, limit)) };
      if (to) params.to = to;
      const raw = await call<any[]>('GET', '/futures/usdt/candlesticks', params, undefined, { timeoutMs: 20_000 });
      return (raw ?? [])
        .map((c): Bar => ({ time: num(c.t), open: num(c.o), high: num(c.h), low: num(c.l), close: num(c.c), volume: num(c.v) }))
        .sort((a, b) => a.time - b.time);
    },

    async account() {
      const a = await call<any>('GET', '/futures/usdt/accounts', {}, undefined, { private: true });
      return {
        total: num(a?.total),
        available: num(a?.available),
        unrealisedPnl: num(a?.unrealised_pnl),
        currency: String(a?.currency ?? 'USDT'),
      };
    },

    async positions() {
      const list = await call<any[]>('GET', '/futures/usdt/positions', {}, undefined, { private: true });
      return (list ?? [])
        .filter((p) => num(p.size) !== 0)
        .map((p): Position => {
          const size = num(p.size);
          const mode = String(p.mode ?? 'single');
          // 双向模式下多空各一条持仓，方向看 mode；单仓看张数正负
          const direction: Direction = mode === 'dual_short' ? 'short' : mode === 'dual_long' ? 'long' : size < 0 ? 'short' : 'long';
          return {
            contract: String(p.contract),
            size: Math.abs(size),
            direction,
            leverage: num(p.leverage) || 1,
            entryPrice: num(p.entry_price),
            markPrice: num(p.mark_price),
            liqPrice: num(p.liq_price),
            unrealisedPnl: num(p.unrealised_pnl),
            value: num(p.value),
            mode,
          };
        });
    },

    async orders() {
      const list = await call<any[]>('GET', '/futures/usdt/orders', { status: 'open' }, undefined, { private: true });
      return (list ?? []).map((o): OpenOrder => ({
        id: String(o.id),
        contract: String(o.contract),
        size: num(o.size),
        left: num(o.left),
        price: num(o.price),
        fillPrice: num(o.fill_price),
        status: String(o.status ?? 'open'),
        reduceOnly: o.is_reduce_only === true || o.reduce_only === true,
        createTime: num(o.create_time),
        tif: String(o.tif ?? 'gtc'),
      }));
    },

    async triggers() {
      const list = await call<any[]>('GET', '/futures/usdt/price_orders', { status: 'open' }, undefined, { private: true });
      return (list ?? []).map((t): PriceOrder => {
        const init = t.initial ?? {};
        const size = num(init.size);
        const auto = String(init.auto_size ?? '');
        // 保护单：按 auto_size（close_long / close_short）认，reduce_only 在 Gate 回读时并不可靠
        const protective = auto === 'close_long' || auto === 'close_short' || init.reduce_only === true;
        const direction: '' | Direction = auto === 'close_long' ? 'long' : auto === 'close_short' ? 'short' : size < 0 ? 'short' : size > 0 ? 'long' : '';
        return {
          id: String(t.id),
          contract: String(init.contract ?? ''),
          direction,
          triggerPrice: num(t.trigger?.price),
          triggerRule: num(t.trigger?.rule),
          size: Math.abs(size),
          protective,
          reduceOnly: init.reduce_only === true,
          closeAll: protective && Math.abs(size) === 0,
          createTime: num(t.create_time),
          expiresAt: num(t.trigger?.expiration),
        };
      });
    },

    async placeOrder(o: OrderInput) {
      const signed = o.size * (o.side === 'long' ? 1 : -1);
      const body: Record<string, unknown> = {
        contract: o.contract,
        size: String(signed),
        price: o.price > 0 ? String(o.price) : '0',
        tif: o.price > 0 ? 'gtc' : 'ioc',
        reduce_only: o.reduceOnly === true,
      };
      const r = await call<any>('POST', '/futures/usdt/orders', {}, body, { private: true });
      return { id: String(r?.id ?? ''), status: String(r?.status ?? 'open'), fillPrice: num(r?.fill_price) };
    },

    async amendOrder(id, o) {
      const body: Record<string, unknown> = {};
      if (o.price !== undefined) body.price = String(o.price);
      if (o.size !== undefined) body.size = String(o.size);
      const r = await call<any>('PUT', '/futures/usdt/orders/' + encodeURIComponent(id), {}, body, { private: true });
      return { id: String(r?.id ?? id) };
    },

    async cancelOrder(id) {
      const r = await call<any>('DELETE', '/futures/usdt/orders/' + encodeURIComponent(id), {}, undefined, { private: true });
      return { id: String(r?.id ?? id) };
    },

    async placeTrigger(t: TriggerInput) {
      const isLong = t.direction === 'long';
      // 止损：多单跌破才平（rule=2），空单涨破才平（rule=1）；止盈反过来
      const rule = t.role === 'stop' ? (isLong ? 2 : 1) : (isLong ? 1 : 2);
      const body = {
        initial: {
          contract: t.contract,
          size: 0,
          price: '0',
          tif: 'ioc',
          reduce_only: true,
          // auto_size 指明平哪一边：双向持仓下它比 isclose 清楚
          auto_size: isLong ? 'close_long' : 'close_short',
        },
        trigger: { strategy: 0, price_type: 0, price: String(t.price), rule },
      };
      const r = await call<any>('POST', '/futures/usdt/price_orders', {}, body, { private: true });
      return { id: String(r?.id ?? '') };
    },

    async cancelTrigger(id) {
      const r = await call<any>('DELETE', '/futures/usdt/price_orders/' + encodeURIComponent(id), {}, undefined, { private: true });
      return { id: String(r?.id ?? id) };
    },

    async setLeverage(name, leverage, mode) {
      // 保证金模式只能在全仓/逐仓之间切，且和杠杆绑在一起改：先改模式，改不动也不阻断
      await call('POST', '/futures/usdt/positions/' + encodeURIComponent(name) + '/margin', { mode, leverage }, undefined, { private: true })
        .catch(() => undefined);
      await call('POST', '/futures/usdt/positions/' + encodeURIComponent(name) + '/leverage', { leverage }, undefined, { private: true });
    },

    async marketClose(name, direction, size) {
      const signed = size * (direction === 'long' ? -1 : 1);
      const r = await call<any>('POST', '/futures/usdt/orders', {}, {
        contract: name, size: String(signed), price: '0', tif: 'ioc', reduce_only: true,
      }, { private: true });
      return { id: String(r?.id ?? ''), status: String(r?.status ?? '') };
    },
  };
}
