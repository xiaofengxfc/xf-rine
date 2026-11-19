import { gatePublic, gatePublicTrade, gatePrivate, requireKeys as requireGateKeys } from '../gate/rest.js';
import { MarketHub } from '../gate/market.js';
import { config, keyHint as cfgKeyHint, keyHintFor as cfgKeyHintFor, restBaseUrl } from '../config.js';
import { netFetch } from '../net.js';
import type {
  Exchange, XContract, XPosition, XOrder, XTrigger, XAccount, XTicker, XCandle,
  XOrderSpec, XTriggerSpec,
} from './types.js';
import type { WebSocketServer } from 'ws';

/**
 * Gate 的适配器。
 *
 * 这一家是「原生的」：内部那套形状本来就是照着 Gate 抄的，所以这里的每个方法
 * 几乎就是一行调用。真正干活的是 gate/rest.ts 和 gate/market.ts，一行没动 ——
 * 加第二家交易所不该顺手把已经跑通的那家重写一遍。
 */

function gateSizeStep(c: XContract): XContract {
  const minText = String(c.order_size_min ?? '');
  const decimalPlaces = /\.(\d+)/.exec(minText)?.[1]?.length ?? 0;
  const decimalsEnabled = c.enable_decimal === true || String(c.enable_decimal) === 'true';
  const places = decimalsEnabled ? Math.max(1, decimalPlaces) : 0;
  return { ...c, size_step: 10 ** -Math.min(12, places) };
}

export class GateExchange implements Exchange {
  readonly id = 'gate' as const;
  readonly label = 'Gate';
  readonly intervals = ['1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d'];

  restBase(): string { return restBaseUrl(); }
  publicBase(): string { return restBaseUrl(); }
  keysConfigured(): boolean { return Boolean(config.key && config.secret); }
  keyHint(): { configured: boolean; hint: string } { return cfgKeyHint(); }
  keyHintFor(env: 'testnet' | 'live'): { configured: boolean; hint: string } { return cfgKeyHintFor(env); }

  requireKeys(): void {
    // 报错文案留在 gate/rest.ts 里：那句话是照着设置页写的，挪走容易两边不一致
    requireGateKeys();
  }

  async contracts(timeoutMs?: number, attemptMs?: number): Promise<XContract[]> {
    const rows = await gatePublic<XContract[]>('/futures/usdt/contracts', {}, timeoutMs, attemptMs);
    return rows.map(gateSizeStep);
  }

  async tradeContract(name: string): Promise<XContract> {
    return gateSizeStep(await gatePublicTrade<XContract>(`/futures/usdt/contracts/${encodeURIComponent(name)}`));
  }

  async publicContract(name: string): Promise<XContract> {
    return gateSizeStep(await gatePublic<XContract>(`/futures/usdt/contracts/${encodeURIComponent(name)}`));
  }

  async candles(name: string, interval: string, limit: number, to?: number): Promise<XCandle[]> {
    const params: Record<string, string | number> = { contract: name, interval, limit };
    if (to) params.to = to;
    return gatePublic<XCandle[]>('/futures/usdt/candlesticks', params);
  }

  tickers(timeoutMs?: number, attemptMs?: number): Promise<XTicker[]> {
    return gatePublic<XTicker[]>('/futures/usdt/tickers', {}, timeoutMs, attemptMs);
  }

  /**
   * 当前环境能交易哪些合约。实盘就是主网全量（null 表示不限制）；
   * 测试网只上架了几十个，得去测试网自己的公开接口拿。
   */
  async tradableNames(): Promise<Set<string> | null> {
    if (config.env !== 'testnet') return null;
    try {
      const res = await netFetch(restBaseUrl() + '/api/v4/futures/usdt/contracts', {
        headers: { Accept: 'application/json', 'X-Gate-Size-Decimal': '1' },
      });
      if (!res.ok) return null;
      const list = (await res.json()) as { name?: string; status?: string }[];
      return new Set(list.filter((c) => c.name && c.status !== 'delisted').map((c) => String(c.name)));
    } catch {
      return null; // 拿不到就别拦，让交易所自己报错
    }
  }

  async account(): Promise<XAccount> {
    const a = await gatePrivate<Record<string, string>>('GET', '/futures/usdt/accounts');
    return {
      total: Number(a.total ?? 0),
      available: Number(a.available ?? 0),
      unrealised_pnl: Number(a.unrealised_pnl ?? 0),
      currency: a.currency ?? 'USDT',
    };
  }

  async positions(contract?: string): Promise<XPosition[]> {
    if (contract) {
      const raw = await gatePrivate<XPosition | XPosition[]>(
        'GET', `/futures/usdt/positions/${encodeURIComponent(contract)}`,
      );
      return Array.isArray(raw) ? raw : [raw];
    }
    return gatePrivate<XPosition[]>('GET', '/futures/usdt/positions');
  }

  async openOrders(contract?: string): Promise<XOrder[]> {
    return gatePrivate<XOrder[]>('GET', '/futures/usdt/orders', { contract, status: 'open' });
  }

  async order(id: string): Promise<XOrder | null> {
    const raw = await gatePrivate<XOrder & { id?: string }>(
      'GET', `/futures/usdt/orders/${encodeURIComponent(id)}`,
    ).catch(() => null);
    return raw && raw.id ? raw : null;
  }

  async placeOrder(spec: XOrderSpec): Promise<XOrder> {
    return gatePrivate<XOrder>('POST', '/futures/usdt/orders', {}, {
      contract: spec.contract,
      // Gate 要用十进制文本接收小数张数，避免 JSON 浮点表示带来的精度损失。
      size: String(spec.size),
      price: spec.price,
      tif: spec.tif,
      reduce_only: spec.reduce_only,
      ...(spec.auto_size ? { auto_size: spec.auto_size } : {}),
      ...(spec.close ? { close: true } : {}),
    });
  }

  async cancelOrder(id: string): Promise<void> {
    await gatePrivate('DELETE', `/futures/usdt/orders/${encodeURIComponent(id)}`);
  }

  triggers(): Promise<XTrigger[]> {
    return gatePrivate<XTrigger[]>('GET', '/futures/usdt/price_orders', { status: 'open' });
  }

  async placeTrigger(spec: XTriggerSpec): Promise<XTrigger> {
    return gatePrivate<XTrigger>('POST', '/futures/usdt/price_orders', {}, spec);
  }

  async cancelTrigger(id: string): Promise<void> {
    await gatePrivate('DELETE', `/futures/usdt/price_orders/${encodeURIComponent(id)}`);
  }

  async setLeverage(name: string, opts: { lev: number; cross: boolean }): Promise<{
    leverage: number; crossLeverageLimit: number; mode: 'cross' | 'isolated';
  }> {
    // Gate 没有单独的保证金模式开关：杠杆传 0 就是全仓，全仓的倍数放在 cross_leverage_limit
    const r = await gatePrivate<Record<string, unknown>>(
      'POST',
      `/futures/usdt/positions/${encodeURIComponent(name)}/leverage`,
      opts.cross ? { leverage: 0, cross_leverage_limit: opts.lev } : { leverage: opts.lev },
    );
    return {
      leverage: Number(r.leverage ?? 0),
      crossLeverageLimit: Number(r.cross_leverage_limit ?? 0),
      mode: opts.cross ? 'cross' : 'isolated',
    };
  }

  marketHub(wss: WebSocketServer): MarketHub {
    return new MarketHub(wss);
  }
}
