import { bgPublic, bgPrivate, PRODUCT } from './rest.js';
import { GateError } from '../exchange/errors.js';
import { config, keyHint as gateKeyHint, keyHintFor as gateKeyHintFor } from '../config.js';
import type {
  Exchange, XContract, XPosition, XOrder, XTrigger, XAccount, XTicker, XCandle,
  XOrderSpec, XTriggerSpec, MarketHub,
} from '../exchange/types.js';
import { BitgetMarketHub } from './market.js';
import { ceilSizeToStep, floorSizeToStep } from '../exchange/size.js';
import { sumBitgetRealisedPnl } from '../exchange/pnl.js';
import type { WebSocketServer } from 'ws';

/**
 * Bitget 的适配器：把它的接口和口径翻成项目内部那套（见 exchange/types.ts）。
 *
 *   1. **张 ↔ 币**。UTA 接口下单和持仓读币数量，内部统一用合约张数。
 *      1 张 = sizeMultiplier 个币，所以发请求时乘、读回时除。
 *   2. **方向**。单向模式靠 signed size 和 reduceOnly 区分，双向模式使用 posSide。
 *   3. **账户模式**。私有账户、持仓、委托及策略止盈止损都走 UTA v3 API。
 */

const LIMIT = 1000;
/** 合约表缓存一小时：最小变动价、乘数不常变 */
const CONTRACT_TTL = 60 * 60_000;
/** 单个合约（带最新价）缓存一分钟：下单校验要用，但价格不能太旧 */
const ONE_TTL = 60_000;
/** 币安那套周期写法 → Bitget 的 granularity。没有的周期不放进来 */
const GRANULARITY: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '4h': '4H', '1d': '1D',
};

interface RawContract {
  symbol?: string;
  sizeMultiplier?: string;
  minTradeNum?: string;
  maxOrderQty?: string;
  maxMarketOrderQty?: string;
  volumePlace?: string;
  pricePlace?: string;
  priceEndStep?: string;
  minLever?: string;
  maxLever?: string;
  takerFeeRate?: string;
  makerFeeRate?: string;
  buyLimitPriceRatio?: string;
  sellLimitPriceRatio?: string;
  fundInterval?: string;
  symbolStatus?: string;
}

type RawPosition = Record<string, unknown>;
type RawOrder = Record<string, unknown>;
type RawAccount = Record<string, unknown>;
type RawFill = Record<string, unknown>;

/** 页面上显示的合约名用 Gate 那套写法：BTCUSDT → BTC_USDT */
export function nameOf(symbol: string): string {
  const s = String(symbol ?? '').toUpperCase();
  if (s.includes('_')) return s;
  if (s.endsWith('USDT')) return s.slice(0, -4) + '_USDT';
  return s;
}

/** 内部合约名 → Bitget 的 symbol */
export function symbolOf(name: string): string {
  return String(name ?? '').toUpperCase().replace(/_/g, '');
}

export function bitgetMarginMode(cross: boolean): 'crossed' | 'isolated' {
  return cross ? 'crossed' : 'isolated';
}

export function bitgetLeveragePayloads(
  name: string,
  leverage: number,
  cross: boolean,
  posMode: 'one_way_mode' | 'hedge_mode',
): Record<string, unknown>[] {
  if (!cross && posMode === 'hedge_mode') {
    // UTA isolated hedge mode sets both sides together. Sending `leverage` with
    // `posSide` omits the fields this endpoint requires and returns 25200.
    return [{
      category: PRODUCT,
      symbol: symbolOf(name),
      marginMode: 'isolated',
      longLeverage: String(leverage),
      shortLeverage: String(leverage),
    }];
  }

  const base = {
    category: PRODUCT,
    symbol: symbolOf(name),
    leverage: String(leverage),
    marginMode: bitgetMarginMode(cross),
  };
  return [base];
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function firstAccountNumber(...values: unknown[]): number {
  for (const value of values) {
    if (value == null || (typeof value === 'string' && value.trim() === '')) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function bitgetAccountSnapshot(account: RawAccount): XAccount {
  // UTA v3 nests per-coin balances under assets; the legacy v2 response has these
  // values at the root. Prefer the UTA USDT valuation to avoid reporting a margin-only
  // accountEquity as the total account balance.
  const assets = Array.isArray(account.assets) ? account.assets as RawAccount[] : [];
  const usdt = assets.find((asset) => String(asset.coin ?? asset.marginCoin ?? '').toUpperCase() === 'USDT');
  return {
    total: firstAccountNumber(account.usdtEquity, usdt?.equity, usdt?.balance, account.accountEquity, account.equity),
    available: firstAccountNumber(usdt?.available, account.unionAvailable, account.available),
    unrealised_pnl: firstAccountNumber(account.usdtUnrealisedPnl, account.unrealisedPnl, account.unrealizedPL),
    currency: 'USDT',
  };
}

/** 按小数位取整，顺手避免 0.00030000000000000003 这种尾巴被交易所拒 */
function fixed(value: number, place: number): string {
  const p = Math.min(12, Math.max(0, Math.round(place)));
  return (Math.round(value * 10 ** p) / 10 ** p).toFixed(p);
}

/** Bitget v2 hedge mode side denotes the position side; tradeSide selects open/close. */
export function bitgetOrderSide(
  posMode: 'one_way_mode' | 'hedge_mode',
  direction: 'long' | 'short',
  reduce: boolean,
): 'buy' | 'sell' {
  if (posMode === 'hedge_mode') return direction === 'long' ? 'buy' : 'sell';
  if (reduce) return direction === 'long' ? 'sell' : 'buy';
  return direction === 'long' ? 'buy' : 'sell';
}

/** UTA v3 hedge-mode orders use the actual trade side when closing positions. */
export function bitgetUtaOrderSide(
  posMode: 'one_way_mode' | 'hedge_mode',
  direction: 'long' | 'short',
  reduce: boolean,
): 'buy' | 'sell' {
  if (posMode === 'hedge_mode' && reduce) return direction === 'long' ? 'sell' : 'buy';
  return bitgetOrderSide(posMode, direction, reduce);
}

/** XOrder.size is signed by the Bitget v2 side field in both position modes. */
export function signedBitgetOrderSize(side: 'buy' | 'sell', sizeCoin: number, multiplier: number): number {
  const size = multiplier > 0 ? sizeCoin / multiplier : sizeCoin;
  return side === 'sell' ? -size : size;
}

export function mapBitgetPosition(raw: RawPosition, multiplier: number): XPosition | null {
  const symbol = String(raw.symbol ?? '');
  const total = num(raw.total);
  if (!symbol || !(multiplier > 0) || !(Math.abs(total) > 0)) return null;

  const holdSide = String(raw.posSide ?? '').toLowerCase();
  const short = holdSide === 'short' || (holdSide !== 'long' && total < 0);
  const holdMode = String(raw.holdMode ?? '').toLowerCase();
  const hedge = holdMode === 'hedge_mode';
  const mark = num(raw.markPrice);
  const size = Math.abs(total) / multiplier;

  return {
    contract: nameOf(symbol),
    size: String(hedge ? size : short ? -size : size),
    mode: hedge ? (short ? 'dual_short' : 'dual_long') : 'single',
    leverage: String(num(raw.leverage)),
    margin_mode: String(raw.marginMode ?? ''),
    entry_price: String(num(raw.avgPrice)),
    mark_price: String(mark),
    liq_price: String(num(raw.liquidationPrice)),
    unrealised_pnl: String(num(raw.unrealisedPnl)),
    realised_pnl: String(num(raw.curRealisedPnl)),
    value: String(Math.abs(total) * mark),
  };
}

export function mapBitgetUtaOrder(raw: RawOrder, multiplier: number): XOrder {
  const sizeCoin = num(raw.qty ?? raw.size);
  const filled = num(raw.cumExecQty ?? raw.baseVolume);
  const side = String(raw.side ?? '').toLowerCase();
  const tradeSide = String(raw.tradeSide ?? '').toLowerCase();
  const hedgeClose = String(raw.holdMode ?? '').toLowerCase() === 'hedge_mode' && tradeSide === 'close';
  const posSide = String(raw.posSide ?? '').toLowerCase();
  const quantity = multiplier > 0 ? sizeCoin / multiplier : sizeCoin;
  // The app treats signed size as position direction for hedge-mode close orders.
  const signed = hedgeClose && (posSide === 'long' || posSide === 'short')
    ? (posSide === 'short' ? -quantity : quantity)
    : signedBitgetOrderSize(side === 'sell' ? 'sell' : 'buy', sizeCoin, multiplier);
  const status = stateOf(raw);
  const reduceOnly = String(raw.reduceOnly ?? '').toLowerCase() === 'yes';

  return {
    id: String(raw.orderId ?? ''),
    contract: nameOf(String(raw.symbol ?? '')),
    size: String(signed),
    left: String(multiplier > 0 ? Math.max(0, sizeCoin - filled) / multiplier : Math.max(0, sizeCoin - filled)),
    price: String(num(raw.price)),
    fill_price: String(num(raw.avgPrice ?? raw.priceAvg)),
    status,
    finish_as: status === 'finished'
      ? String(raw.orderStatus ?? '').toLowerCase() === 'filled' ? 'filled' : 'cancelled'
      : '',
    is_reduce_only: tradeSide === 'close' || reduceOnly,
    create_time: Math.round(num(raw.createdTime ?? raw.cTime ?? raw.uTime) / 1000),
    tif: String(raw.timeInForce ?? raw.force ?? 'gtc').toLowerCase(),
  };
}

export function mapBitgetStrategyTriggers(raw: RawOrder, multiplier: number): XTrigger[] {
  const id = String(raw.orderId ?? '');
  const symbol = String(raw.symbol ?? '');
  const rawPositionSide = String(raw.posSide ?? '').toLowerCase();
  const side = String(raw.side ?? '').toLowerCase();
  const positionSide = rawPositionSide === 'long' || rawPositionSide === 'short'
    ? rawPositionSide
    : side === 'sell' ? 'long' : side === 'buy' ? 'short' : '';
  const status = String(raw.status ?? '').toLowerCase();
  if (!id || !symbol || (positionSide !== 'long' && positionSide !== 'short')) return [];
  if (status && status !== 'pending' && status !== 'submitting') return [];

  const direction = positionSide as 'long' | 'short';
  const size = num(raw.qty);
  const common: XTrigger['initial'] = {
    contract: nameOf(symbol),
    size: multiplier > 0 ? size / multiplier : size,
    price: '0',
    tif: 'ioc',
    reduce_only: true,
    close: false,
    auto_size: direction === 'long' ? 'close_long' : 'close_short',
  };
  const createTime = Math.round(num(raw.createdTime) / 1000);
  const output: XTrigger[] = [];

  for (const [kind, priceField] of [['stop', 'stopLoss'], ['target', 'takeProfit']] as const) {
    const price = num(raw[priceField]);
    if (!(price > 0)) continue;
    const stop = kind === 'stop';
    output.push({
      id: `${kind}:${id}`,
      cancel_id: id,
      initial: { ...common },
      trigger: {
        strategy: 0,
        price_type: 0,
        price: String(price),
        rule: direction === 'long' ? (stop ? 2 : 1) : (stop ? 1 : 2),
        expiration: 0,
      },
      create_time: createTime,
    });
  }

  return output;
}

/** 合约表里的原始条目 → 项目内部的合约形状 */
function toContract(raw: RawContract, last = 0, mark = 0): XContract {
  const mult = num(raw.sizeMultiplier);
  const pricePlace = num(raw.pricePlace);
  const step = num(raw.priceEndStep, 1);
  const round = step / 10 ** pricePlace;
  const volumePlace = Math.min(12, Math.max(0, Math.round(num(raw.volumePlace))));
  const sizeStep = mult > 0 ? Math.pow(10, -volumePlace) / mult : 1;
  const minSize = mult > 0 ? num(raw.minTradeNum) / mult : 0;
  const maxQty = num(raw.maxOrderQty) || num(raw.maxMarketOrderQty);
  const maxSize = mult > 0 ? maxQty / mult : 0;
  const status = String(raw.symbolStatus ?? '');
  return {
    name: nameOf(String(raw.symbol ?? '')),
    quanto_multiplier: String(mult),
    // 换成「张」：页面上的张数和 Gate 那边是同一个意思
    order_size_min: minSize > 0 ? ceilSizeToStep(minSize, sizeStep) : sizeStep,
    order_size_max: maxSize > 0 ? floorSizeToStep(maxSize, sizeStep) : 0,
    size_step: sizeStep,
    // 下单接口的 size 是币数量，精度直接用交易所返回的 volumePlace。
    size_place: volumePlace,
    order_price_round: String(round),
    mark_price_round: String(round),
    leverage_min: String(num(raw.minLever, 1)),
    leverage_max: String(num(raw.maxLever, 1)),
    last_price: String(last || 0),
    mark_price: String(mark || last || 0),
    funding_rate: '0',
    funding_rate_indicative: '0',
    // Bitget 给的是小时数（8 = 8 小时一次）
    funding_interval: num(raw.fundInterval, 0),
    in_delisting: status === 'off' || status === 'delisted',
    status,
    position_size: 0,
    taker_fee_rate: String(num(raw.takerFeeRate, 0.0006)),
    maker_fee_rate: String(num(raw.makerFeeRate, 0.0002)),
    // 限价单允许偏离现价的比例，和 Gate 的 order_price_deviate 一个量纲
    order_price_deviate: String(Math.max(0.05, num(raw.buyLimitPriceRatio, 0.05))),
  };
}

/** 订单状态：routes 只认 open，其余一律当结束 */
function stateOf(raw: RawOrder): string {
  const s = String(raw.state ?? raw.orderStatus ?? raw.status ?? '').toLowerCase();
  return s === 'live' || s === 'new' || s === 'partially_filled' || s === 'init' ? 'open' : 'finished';
}

export class BitgetExchange implements Exchange {
  readonly id = 'bitget' as const;
  readonly label = 'Bitget';
  /** Bitget 没有 8h / 7d / 10s，页面只列这些都有的那几个 */
  readonly intervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

  private table: { at: number; list: XContract[]; raw: Map<string, RawContract> } | null = null;
  private tableBusy: Promise<void> | null = null;
  private oneCache = new Map<string, { at: number; c: XContract; raw: RawContract }>();
  private settingsCache: { at: number; value: RawAccount } | null = null;
  private settingsBusy: Promise<RawAccount | null> | null = null;
  /** 合约 → 保证金模式。下单必须带，读不到就按账户默认 */
  private marginModes = new Map<string, 'crossed' | 'isolated'>();
  private posMode: 'one_way_mode' | 'hedge_mode' | '' = '';
  private posModeAt = 0;
  /** 挂单 id → 合约名。撤单和改单只拿得到 id，Bitget 却要 symbol */
  private orderSymbols = new Map<string, string>();

  restBase(): string { return 'https://api.bitget.com'; }
  publicBase(): string { return 'https://api.bitget.com'; }
  keysConfigured(): boolean { return Boolean(config.key && config.secret && config.passphrase); }
  keyHint(): { configured: boolean; hint: string } { return gateKeyHint(); }
  keyHintFor(env: 'testnet' | 'live'): { configured: boolean; hint: string } { return gateKeyHintFor(env); }

  requireKeys(): void {
    if (!this.keysConfigured()) {
      throw new GateError(
        401, 'NO_KEYS',
        '服务端没有配齐 Bitget 的三样密钥（KEY / SECRET / PASSPHRASE），到设置页填上才能看账户和下单',
        'Bitget',
      );
    }
  }

  // ---------- 合约表 ----------

  private async refreshTable(force = false): Promise<void> {
    if (!force && this.table && Date.now() - this.table.at < CONTRACT_TTL) return;
    if (this.tableBusy) return this.tableBusy;
    this.tableBusy = (async () => {
      const list = await bgPublic<RawContract[]>(
        '/api/v2/mix/market/contracts', { productType: PRODUCT }, 60_000, 50_000,
      );
      const raw = new Map<string, RawContract>();
      const out: XContract[] = [];
      for (const r of list ?? []) {
        const sym = String(r.symbol ?? '');
        if (!sym) continue;
        raw.set(sym, r);
        out.push(toContract(r));
      }
      this.table = { at: Date.now(), list: out, raw };
      console.log('[bitget] 合约表就绪：' + out.length + ' 个');
    })().finally(() => { this.tableBusy = null; });
    return this.tableBusy;
  }

  async contracts(timeoutMs?: number): Promise<XContract[]> {
    await this.refreshTable(true);
    void timeoutMs;
    return this.table?.list ?? [];
  }

  /** 只取单个合约：整张表八百多个，一次下单不该等它 */
  private async rawOne(name: string): Promise<RawContract> {
    const sym = symbolOf(name);
    if (this.table && Date.now() - this.table.at < CONTRACT_TTL) {
      const hit = this.table.raw.get(sym);
      if (hit) return hit;
    }
    const list = await bgPublic<RawContract[]>(
      '/api/v2/mix/market/contracts', { productType: PRODUCT, symbol: sym }, 30_000, 25_000,
    );
    const one = list?.[0];
    if (!one) {
      throw new GateError(
        404, 'CONTRACT_NOT_FOUND',
        'Bitget 上没有合约 ' + name + '（' + sym + '）—— 名字写错了，或者它已经下架',
        'Bitget',
      );
    }
    return one;
  }

  /** 1 张等于多少币。换算全靠它，拿不到就按 1:1 猜是不行的 */
  private async multiplierOf(name: string): Promise<number> {
    const raw = await this.rawOne(name);
    const m = num(raw.sizeMultiplier);
    if (!(m > 0)) {
      throw new GateError(502, 'BAD_CONTRACT', 'Bitget 没给出 ' + name + ' 的合约乘数，没法换算张数', 'Bitget');
    }
    return m;
  }

  async tradeContract(name: string): Promise<XContract> {
    return this.publicContract(name);
  }

  async publicContract(name: string): Promise<XContract> {
    const hit = this.oneCache.get(name);
    if (hit && Date.now() - hit.at < ONE_TTL) return hit.c;
    const raw = await this.rawOne(name);
    const sym = symbolOf(name);
    // 合约表里没有最新价，价格得问行情 —— 市价单按它估名义价值，偏离校验也用它
    let last = 0;
    let mark = 0;
    try {
      const t = await bgPublic<Record<string, unknown> | Record<string, unknown>[]>(
        '/api/v2/mix/market/ticker', { productType: PRODUCT, symbol: sym }, 15_000,
      );
      const row = Array.isArray(t) ? t[0] : t;
      last = num(row?.lastPr);
      mark = num(row?.markPrice);
    } catch { /* 拿不到价格就先按 0 返回，调用方会说不清价格 */ }
    const c = toContract(raw, last, mark);
    this.oneCache.set(name, { at: Date.now(), c, raw });
    return c;
  }

  async tradableNames(): Promise<Set<string> | null> {
    /**
     * 模拟盘（PAPTRADING）和实盘是同一套合约，没有「只在主网有」的问题，
     * 所以不限制 —— 返回 null 表示全都能交易，和 Gate 实盘一个语义。
     */
    return null;
  }

  // ---------- 行情 ----------

  async candles(name: string, interval: string, limit: number, to?: number): Promise<XCandle[]> {
    const g = GRANULARITY[interval];
    if (!g) {
      throw new GateError(
        400, 'NO_INTERVAL',
        'Bitget 没有 ' + interval + ' 这个周期（支持 ' + Object.keys(GRANULARITY).join(' / ') + '）',
        'Bitget',
      );
    }
    const sym = symbolOf(name);
    const cap = Math.min(Math.max(1, Math.round(limit)), LIMIT);
    const stepMs = stepOf(interval) * 1000;
    const out: XCandle[] = [];
    const seen = new Set<number>();
    let endMs = to && to > 0 ? Math.round(to) * 1000 : Date.now();

    /**
     * 一次最多给 90 天窗口（4h 就是 540 根），要 1000 根得翻两页。
     * 这里自己往前翻，把「一次给不满」挡在这一层 —— 上层的翻页逻辑是按
     * 「不满一页就是到头了」写的，让它看见 540 根会把历史误判成没有了。
     */
    for (let guard = 0; guard < 8 && out.length < cap; guard += 1) {
      const rows = await bgPublic<unknown[][]>(
        '/api/v2/mix/market/candles',
        { symbol: sym, productType: PRODUCT, granularity: g, limit: cap - out.length, endTime: endMs },
        25_000, 20_000,
      ).catch(() => [] as unknown[][]);
      if (!Array.isArray(rows) || rows.length === 0) break;
      let oldest = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        const t = Math.round(Number(r?.[0]) / 1000);
        if (!Number.isFinite(t) || t <= 0 || seen.has(t)) continue;
        seen.add(t);
        if (t < oldest) oldest = t;
        out.push({
          t,
          o: String(r?.[1] ?? '0'),
          h: String(r?.[2] ?? '0'),
          l: String(r?.[3] ?? '0'),
          c: String(r?.[4] ?? '0'),
          v: Number(r?.[5] ?? 0),
          turnover: r?.[6] == null ? undefined : Number(r[6]),
        });
      }
      if (!Number.isFinite(oldest)) break;
      // 没往前走就别再要，否则同一个窗口会一直返回同一页
      const nextEnd = oldest * 1000 - stepMs;
      if (nextEnd >= endMs) break;
      endMs = nextEnd;
      if (rows.length < cap - out.length) {
        // 这一页确实不满，但不代表没有了（窗口限制），继续往前翻
        continue;
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out.slice(Math.max(0, out.length - cap));
  }

  async tickers(timeoutMs?: number, attemptMs?: number): Promise<XTicker[]> {
    const [list] = await Promise.all([
      bgPublic<Record<string, unknown>[]>(
        '/api/v2/mix/market/tickers', { productType: PRODUCT }, timeoutMs ?? 60_000, attemptMs ?? 45_000,
      ),
      this.refreshTable().catch(() => undefined),
    ]);
    const rows: XTicker[] = [];
    for (const t of list ?? []) {
      const sym = String(t.symbol ?? '');
      if (!sym) continue;
      const raw = this.table?.raw.get(sym);
      const mult = num(raw?.sizeMultiplier);
      const last = num(t.lastPr);
      if (!(last > 0)) continue;
      rows.push({
        contract: nameOf(sym),
        last: String(last),
        mark_price: String(num(t.markPrice, last)),
        // Gate 给的是百分数，Bitget 给的是比例
        change_percentage: String(num(t.change24h) * 100),
        volume_24h_quote: String(num(t.quoteVolume)),
        funding_rate: String(num(t.fundingRate)),
        quanto_multiplier: String(mult),
        // 未平仓张数：Bitget 的 holdingAmount 是币数
        total_size: String(mult > 0 ? num(t.holdingAmount) / mult : 0),
      });
    }
    return rows;
  }

  // ---------- 账户与持仓 ----------

  private async accountSettings(): Promise<RawAccount | null> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < 60_000) return this.settingsCache.value;
    if (this.settingsBusy) return this.settingsBusy;
    this.settingsBusy = bgPrivate<RawAccount>('GET', '/api/v3/account/settings')
      .then((value) => {
        this.settingsCache = { at: Date.now(), value };
        return value;
      })
      .catch(() => this.settingsCache?.value ?? null)
      .finally(() => { this.settingsBusy = null; });
    return this.settingsBusy;
  }

  async account(): Promise<XAccount> {
    this.requireKeys();
    const [assets, settings] = await Promise.all([
      bgPrivate<RawAccount>('GET', '/api/v3/account/assets'),
      this.accountSettings(),
    ]);
    const mode = String(settings?.holdMode ?? '');
    if (mode === 'one_way_mode' || mode === 'hedge_mode') {
      this.posMode = mode;
      this.posModeAt = Date.now();
    }
    const symbolConfigs = Array.isArray(settings?.symbolConfigList)
      ? settings.symbolConfigList as RawAccount[]
      : [];
    for (const symbolConfig of symbolConfigs) {
      const name = nameOf(String(symbolConfig.symbol ?? ''));
      const marginMode = String(symbolConfig.marginMode ?? '');
      if (String(symbolConfig.category ?? '') === PRODUCT && name
        && (marginMode === 'crossed' || marginMode === 'isolated')) {
        this.marginModes.set(name, marginMode);
      }
    }
    return bitgetAccountSnapshot(assets);
  }

  async dailyRealisedPnl(fromMs: number, toMs: number): Promise<number> {
    if (!(toMs > fromMs)) return 0;
    const limit = 100;
    let cursor = '';
    let total = 0;

    while (true) {
      const page = await bgPrivate<{ list?: RawFill[]; cursor?: string | number }>(
        'GET', '/api/v3/trade/fills', {
          category: PRODUCT,
          startTime: fromMs,
          endTime: toMs,
          limit,
          cursor,
        },
      );
      const fills = Array.isArray(page?.list) ? page.list : [];
      total += sumBitgetRealisedPnl(fills.map((fill) => ({
        tradeSide: fill.tradeSide,
        createdTime: fill.createdTime,
        execPnl: fill.execPnl,
      })), fromMs, toMs);

      const next = String(page?.cursor ?? '');
      if (!next || next === cursor || fills.length === 0) return total;
      cursor = next;
    }
  }

  private async currentPosMode(): Promise<'one_way_mode' | 'hedge_mode'> {
    if (this.posMode && Date.now() - this.posModeAt < 60_000) return this.posMode;
    try { await this.account(); } catch { /* 读不到就按单向持仓处理 */ }
    return this.posMode === 'hedge_mode' ? 'hedge_mode' : 'one_way_mode';
  }

  async positions(contract?: string): Promise<XPosition[]> {
    this.requireKeys();
    // 先把合约表拿下来：下面每一行都要按乘数换算张数，逐个去问太慢
    await this.refreshTable().catch(() => undefined);
    const data = await bgPrivate<{ list?: RawPosition[] }>(
      'GET', '/api/v3/position/current-position',
      { category: PRODUCT },
    );
    const rows = Array.isArray(data?.list) ? data.list : [];
    const out: XPosition[] = [];
    for (const p of rows) {
      const name = nameOf(String(p.symbol ?? ''));
      if (!name || (contract && name !== contract)) continue;
      const multiplier = await this.multiplierOf(name).catch(() => 0);
      const row = mapBitgetPosition(p, multiplier);
      if (!row) continue;
      const mode = String(p.holdMode ?? '');
      if (mode === 'one_way_mode' || mode === 'hedge_mode') {
        this.posMode = mode;
        this.posModeAt = Date.now();
      }
      const marginMode = String(p.marginMode ?? '');
      if (marginMode === 'crossed' || marginMode === 'isolated') this.marginModes.set(name, marginMode);
      out.push(row);
    }
    return out;
  }

  // ---------- 委托 ----------

  private toOrder(raw: RawOrder, name: string, mult: number): XOrder {
    return mapBitgetUtaOrder({ ...raw, symbol: name }, mult);
  }

  async openOrders(contract?: string): Promise<XOrder[]> {
    this.requireKeys();
    await this.refreshTable().catch(() => undefined);
    const list: RawOrder[] = [];
    let cursor = '';
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const params: Record<string, string | number> = { category: PRODUCT, limit: 100 };
      if (contract) params.symbol = symbolOf(contract);
      if (cursor) params.cursor = cursor;
      const page = await bgPrivate<{ list?: RawOrder[]; cursor?: string }>(
        'GET', '/api/v3/trade/unfilled-orders', params,
      );
      const pageRows = Array.isArray(page?.list) ? page.list : [];
      list.push(...pageRows);
      const next = String(page?.cursor ?? '');
      if (!next || next === cursor || pageRows.length === 0) break;
      cursor = next;
    }
    const out: XOrder[] = [];
    for (const raw of list) {
      const sym = String(raw.symbol ?? '');
      if (!sym) continue;
      const name = nameOf(sym);
      if (contract && name !== contract) continue;
      const mult = await this.multiplierOf(name).catch(() => 0);
      const o = this.toOrder(raw, name, mult);
      if (o.id) this.orderSymbols.set(o.id, name);
      out.push(o);
    }
    return out;
  }

  /** 按 id 找一张委托。改单和撤单都只有 id，得先把它翻回合约名 */
  async order(id: string): Promise<XOrder | null> {
    this.requireKeys();
    const open = await this.openOrders().catch(() => [] as XOrder[]);
    const hit = open.find((o) => o.id === id);
    if (hit) return hit;
    const name = this.orderSymbols.get(id);
    if (!name) return null;
    const mult = await this.multiplierOf(name).catch(() => 0);
    const raw = await bgPrivate<RawOrder>(
      'GET', '/api/v3/trade/order-info',
      { orderId: id },
    ).catch(() => null);
    return raw && raw.orderId ? this.toOrder(raw, name, mult) : null;
  }

  async placeOrder(spec: XOrderSpec): Promise<XOrder> {
    this.requireKeys();
    const name = spec.contract;
    const sym = symbolOf(name);
    const mult = await this.multiplierOf(name);
    const info = await this.publicContract(name);
    // 张 → 币要按 Bitget 的位数写，多一位少一位都不行
    const volumePlace = info.size_place ?? Math.max(0, -Math.floor(Math.log10(mult)));
    const pricePlace = decimalPlaces(info.order_price_round);
    const posMode = await this.currentPosMode();

    /** 整边平仓：Bitget 没有「按方向全平」这种写法，得先知道手里有多少 */
    let contracts = Math.abs(Number(spec.size) || 0);
    let reduce = Boolean(spec.reduce_only);
    let dir: 'long' | 'short' = Number(spec.size) >= 0 ? 'long' : 'short';
    if (spec.auto_size) {
      dir = spec.auto_size === 'close_long' ? 'long' : 'short';
      const sides = await this.positions(name);
      const mine = sides.find((s) => (s.mode.includes('short') ? 'short' : 'long') === dir
        && Math.abs(Number(s.size)) > 0);
      if (!mine) {
        throw new GateError(
          400, 'NO_POSITION',
          '当前没有' + (dir === 'long' ? '多' : '空') + '头持仓，没有可平的',
          'Bitget',
        );
      }
      contracts = Math.abs(Number(mine.size));
      reduce = true;
    }
    if (!(contracts > 0)) throw new GateError(400, 'BAD_INPUT', '张数不合法', 'Bitget');

    const price = Number(spec.price ?? 0);
    const isMarket = !(price > 0);
    let side: 'buy' | 'sell';
    const body: Record<string, unknown> = {
      symbol: sym,
      category: PRODUCT,
      qty: fixed(contracts * mult, volumePlace),
      orderType: isMarket ? 'market' : 'limit',
      marginMode: await this.marginModeFor(name, mult),
    };

    side = bitgetUtaOrderSide(posMode, dir, reduce);
    body.side = side;
    if (posMode === 'hedge_mode') body.posSide = dir;
    if (reduce && posMode === 'one_way_mode') body.reduceOnly = 'yes';

    if (!isMarket) {
      body.price = fixed(price, pricePlace);
      const force = String(spec.tif ?? 'gtc').toLowerCase();
      body.timeInForce = force === 'poc' ? 'post_only' : force === 'ioc' || force === 'fok' ? force : 'gtc';
    }

    const data = await bgPrivate<Record<string, unknown>>(
      'POST', '/api/v3/trade/place-order', {}, body,
    );
    const id = String(data?.orderId ?? '');
    if (!id) {
      throw new GateError(502, 'BAD_RESPONSE', 'Bitget 下单没有回订单号，去「委托」里核对一下', 'Bitget');
    }
    this.orderSymbols.set(id, name);
    // 先把回执按我们发出去的样子填好；查得到明细就以明细为准（市价单通常已经成交）
    const guess: XOrder = {
      id,
      contract: name,
      // hedge mode's side describes the position through posSide; retain that position sign.
      size: String((posMode === 'hedge_mode' ? (dir === 'short' ? -1 : 1) : (side === 'sell' ? -1 : 1)) * contracts),
      left: String(contracts),
      price: isMarket ? '0' : String(price),
      fill_price: '0',
      status: 'open',
      finish_as: '',
      is_reduce_only: reduce,
      create_time: Math.round(Date.now() / 1000),
      tif: String(body.timeInForce ?? 'gtc'),
    };
    const detail = await this.order(id).catch(() => null);
    return detail ?? guess;
  }

  private async marginModeFor(name: string, _mult: number): Promise<string> {
    const has = this.marginModes.get(name);
    if (has) return has;
    const sides = await this.positions(name).catch(() => [] as XPosition[]);
    void sides;
    const again = this.marginModes.get(name);
    if (again) return again;
    return this.marginModes.get('__default__') ?? 'crossed';
  }

  async cancelOrder(id: string): Promise<void> {
    this.requireKeys();
    let name = this.orderSymbols.get(id);
    if (!name) {
      // 没在本地见过这张单（比如页面刷新过），就从挂单列表里认
      await this.openOrders().catch(() => [] as XOrder[]);
      name = this.orderSymbols.get(id);
    }
    if (!name) {
      throw new GateError(404, 'ORDER_NOT_FOUND', '找不到这张委托，可能已经成交或撤掉了', 'Bitget');
    }
    await bgPrivate('POST', '/api/v3/trade/cancel-order', {}, {
      category: PRODUCT,
      symbol: symbolOf(name),
      orderId: id,
    });
  }

  // ---------- 触发单（止损 / 止盈）----------

  async triggers(): Promise<XTrigger[]> {
    this.requireKeys();
    await this.refreshTable().catch(() => undefined);
    const list = await bgPrivate<RawOrder[]>(
      'GET', '/api/v3/trade/unfilled-strategy-orders',
      { category: PRODUCT, type: 'tpsl' },
    );
    const out: XTrigger[] = [];
    for (const raw of list) {
      const sym = String(raw.symbol ?? '');
      if (!sym) continue;
      const name = nameOf(sym);
      const mult = await this.multiplierOf(name).catch(() => 0);
      out.push(...mapBitgetStrategyTriggers(raw, mult));
    }
    return out;
  }

  async placeTrigger(spec: XTriggerSpec): Promise<XTrigger> {
    this.requireKeys();
    const name = spec.initial.contract;
    const sym = symbolOf(name);
    const info = await this.publicContract(name);
    const pricePlace = decimalPlaces(info.order_price_round);
    const dir: 'long' | 'short' = spec.initial.auto_size === 'close_short' ? 'short' : 'long';
    const rule = Number(spec.trigger.rule);
    // 多头止损是「跌到某价」（rule 2），多头止盈是「涨到某价」（rule 1）；空头反过来
    const isLoss = (dir === 'long') === (rule === 2);
    const posMode = await this.currentPosMode();
    const price = Number(spec.trigger.price);
    if (!(price > 0)) throw new GateError(400, 'BAD_INPUT', '触发价不合法', 'Bitget');

    const body: Record<string, unknown> = {
      symbol: sym,
      category: PRODUCT,
      type: 'tpsl',
      side: dir === 'long' ? 'sell' : 'buy',
      tpslMode: 'full',
      reduceOnly: 'yes',
      marginMode: await this.marginModeFor(name, await this.multiplierOf(name)),
      ...(posMode === 'hedge_mode' ? { posSide: dir } : {}),
      ...(isLoss
        ? { stopLoss: fixed(price, pricePlace), slTriggerBy: 'market', slOrderType: 'market' }
        : { takeProfit: fixed(price, pricePlace), tpTriggerBy: 'market', tpOrderType: 'market' }),
    };

    const data = await bgPrivate<{ orderId?: string }>(
      'POST', '/api/v3/trade/place-strategy-order', {}, body,
    );
    const id = String(data?.orderId ?? '');
    if (!id) throw new GateError(502, 'BAD_RESPONSE', 'Bitget 没有回止盈止损单号', 'Bitget');
    return {
      id,
      cancel_id: id,
      initial: { ...spec.initial },
      trigger: { ...spec.trigger, price: String(price) },
      create_time: Math.round(Date.now() / 1000),
    };
  }

  async cancelTrigger(id: string): Promise<void> {
    this.requireKeys();
    await bgPrivate('POST', '/api/v3/trade/cancel-strategy-order', {}, {
      orderId: id,
    });
  }

  // ---------- 杠杆 / 保证金模式 ----------

  async setLeverage(name: string, opts: { lev: number; cross: boolean }): Promise<{
    leverage: number; crossLeverageLimit: number; mode: 'cross' | 'isolated';
  }> {
    this.requireKeys();
    const posMode = await this.currentPosMode();
    const marginMode = bitgetMarginMode(opts.cross);
    for (const body of bitgetLeveragePayloads(name, opts.lev, opts.cross, posMode)) {
      await bgPrivate('POST', '/api/v3/account/set-leverage', {}, body);
    }
    this.marginModes.set(name, marginMode);
    const lev = opts.lev;
    return {
      leverage: lev || opts.lev,
      crossLeverageLimit: opts.cross ? lev || opts.lev : 0,
      mode: opts.cross ? 'cross' : 'isolated',
    };
  }

  marketHub(wss: WebSocketServer): MarketHub {
    return new BitgetMarketHub(wss);
  }
}

/** 一个价格刻度是几位小数（0.5 → 1，0.0001 → 4） */
function decimalPlaces(step: string | number): number {
  const s = String(step);
  const m = /^\d+(?:\.(\d+))?$/.exec(s);
  if (!m) return 0;
  return Math.min(12, m[1]?.length ?? 0);
}

function stepOf(interval: string): number {
  const m = /^(\d+)([mhd])$/.exec(interval);
  if (!m) return 60;
  const n = Number(m[1]);
  return m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n * 86400;
}
