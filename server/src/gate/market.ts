import WebSocket from 'ws';
import type { WebSocketServer } from 'ws';
import { marketWsUrl } from '../config.js';
import { isStale } from '../wsRoute.js';
import { instrumentField, instrumentFromSymbol } from '@xfrine/instrument';

/**
 * 播给页面的每一条行情都同时带「裸合约名」和「完整身份」。
 *
 * 过渡期的双写：老的 contract 字段保持原样，老代码一行都不用动；
 * 新的 instrument 形如 gate:perp:BTC_USDT，页面以后按它区分交易所和市场。
 * 等前端全部改读 instrument 之后，contract 才能谈删除。
 */
const instrumentOf = (symbol: string): string | undefined =>
  instrumentField(instrumentFromSymbol(symbol, 'gate'));

/** 连上以后一直没有数据多久算假死。Gate 20 秒一次心跳，留足余量 */
const STALE_MS = (() => {
  const n = Number(process.env.XF_WS_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
})();

export interface GateCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: number;
  a?: string;
  w?: boolean;
}

interface GateTrade {
  id: number;
  size: number;
  price: string;
  create_time_ms: number;
  contract: string;
}

interface GateTicker {
  contract: string;
  last: string;
  mark_price: string;
  change_percentage: string;
  funding_rate: string;
  volume_24h_quote: string;
}

type Client = { id: number; send: (data: string) => void };

/**
 * 一条 Gate 公共行情连接，前端订阅按引用计数映射到 Gate 的频道。
 * Gate 断线自动重连，重连后把当前所有需要的频道重新订阅一遍。
 */
export class MarketHub {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private wanted = new Map<string, { channel: string; payload: string[]; refs: Set<number> }>();
  private clients = new Map<number, Client>();
  private nextClientId = 1;
  private alive = false;
  private openedAt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  /** 最后一帧的时刻，以及假死看门狗 */
  private lastMessageAt = 0;
  private staleTimer: NodeJS.Timeout | null = null;

  /** 存一份监听函数：换交易所时要把旧 hub 从 wss 上摘掉，否则两条连接都在跑 */
  private onConn: (sock: WebSocket) => void;

  constructor(private wss: WebSocketServer) {
    this.onConn = (sock: WebSocket) => {
      const id = this.nextClientId++;
      const client: Client = {
        id,
        send: (data) => {
          if (sock.readyState === sock.OPEN) sock.send(data);
        },
      };
      this.clients.set(id, client);
      sock.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
      sock.on('message', (raw) => {
        try {
          this.onClientMessage(client, raw.toString());
        } catch (err) {
          console.warn('[ws] 解析客户端消息失败:', err instanceof Error ? err.message : String(err));
        }
      });
      sock.on('close', () => {
        this.clients.delete(id);
        for (const [key, sub] of this.wanted) {
          if (sub.refs.delete(id) && sub.refs.size === 0) {
            this.sendToGate({ time: Math.floor(Date.now() / 1000), channel: sub.channel, event: 'unsubscribe', payload: sub.payload });
            this.wanted.delete(key);
          }
        }
      });
    };
    this.wss.on('connection', this.onConn);
  }

  private onClientMessage(client: Client, raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type === 'subscribe' && typeof msg.contract === 'string') {
      /**
       * 合约名不能按 ASCII 白名单洗。
       *
       * Gate 上有 牛逼_USDT 这种中文合约，洗完变成 "_USDT" —— 订阅出去的是一个不存在的合约，
       * 这 5 个币的 K 线、最新价、逐笔永远不来，图上就停在 REST 快照那一刻。
       * 只挡控制字符和空白（JSON 里本来就安全，这里只是别把怪东西转给交易所），长度按 Gate 的上限截。
       */
      const contract = String(msg.contract).replace(/[\u0000-\u001f\u007f\s]/g, '').slice(0, 32);
      const interval = typeof msg.interval === 'string' ? msg.interval.replace(/[^0-9a-zA-Z]/g, '') : '1m';
      // 单连接只保持一组订阅，切换合约时先退旧的
      this.dropAllRefs(client.id);
      this.addWanted(client.id, `candles:${interval}:${contract}`, 'futures.candlesticks', [interval, contract]);
      this.addWanted(client.id, `trades:${contract}`, 'futures.trades', [contract]);
      // 最新价和标记价也走推送：轮询一次要十几秒，持仓的已盈亏就跟着旧价算，
      // 看上去像「数据半天不动」。标记价才是交易所算盈亏用的那个价。
      this.addWanted(client.id, `tickers:${contract}`, 'futures.tickers', [contract]);
      client.send(JSON.stringify({ type: 'subscribed', contract, interval }));
    }
  }

  private dropAllRefs(clientId: number): void {
    for (const [key, sub] of [...this.wanted]) {
      if (sub.refs.delete(clientId) && sub.refs.size === 0) {
        this.sendToGate({ time: Math.floor(Date.now() / 1000), channel: sub.channel, event: 'unsubscribe', payload: sub.payload });
        this.wanted.delete(key);
      }
    }
  }

  private addWanted(clientId: number, key: string, channel: string, payload: string[]): void {
    let sub = this.wanted.get(key);
    if (!sub) {
      sub = { channel, payload, refs: new Set() };
      this.wanted.set(key, sub);
      this.sendToGate({ time: Math.floor(Date.now() / 1000), channel, event: 'subscribe', payload });
    }
    sub.refs.add(clientId);
  }

  private sendToGate(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  connect(): void {
    if (this.ws) return;
    const ws = new WebSocket(marketWsUrl(), { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.alive = true;
      this.openedAt = Date.now();
      this.lastMessageAt = Date.now();
      this.reconnectAttempt = 0;
      console.log('[ws] gate connected');
      for (const sub of this.wanted.values()) {
        this.sendToGate({ time: Math.floor(Date.now() / 1000), channel: sub.channel, event: 'subscribe', payload: sub.payload });
      }
      // Gate 文档要求客户端定时发 futures.ping，否则连接会被服务端掐掉
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        this.sendToGate({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' });
      }, 20_000);
      this.heartbeat.unref();
      /**
       * 假死看门狗。
       *
       * TUN、代理节点掉线的时候，TCP 常常还举着 —— readyState 是 OPEN，
       * 但一帧都不来。只看连接状态的话，页面会一直停在「已连接」的旧行情上。
       */
      if (this.staleTimer) clearInterval(this.staleTimer);
      this.staleTimer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (!isStale({ now, lastMessageAt: this.lastMessageAt, staleMs: STALE_MS, subscriptions: this.wanted.size })) return;
        console.warn('[ws] gate 已 ' + Math.round((now - this.lastMessageAt) / 1000) + ' 秒没有任何数据，重连');
        try { this.ws.terminate(); } catch { /* 已经断了 */ }
      }, Math.min(15_000, Math.max(1000, Math.round(STALE_MS / 6))));
      this.staleTimer.unref();
    });

    // 交易所偶尔会推形状不对的帧。不兜住的话异常会冒到事件循环上把进程带走 ——
    // 页面还开着，数据却停在那一刻，看起来就像「均价跑到别处去了」。
    ws.on('message', (buf) => {
      this.lastMessageAt = Date.now();
      try {
        this.onGateMessage(buf.toString());
      } catch (err) {
        console.warn('[ws] 解析行情帧失败:', err instanceof Error ? err.message : String(err));
      }
    });

    ws.on('close', (code, reason) => {
      this.alive = false;
      this.ws = null;
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
      console.warn(`[ws] gate closed code=${code} reason=${reason.toString() || '(none)'} uptime=${Date.now() - this.openedAt}ms`);
      this.broadcast({ type: 'gate_down' });
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.warn('[ws] gate error:', err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onGateMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.channel === 'futures.candlesticks' && Array.isArray(msg.result)) {
      const c: GateCandle = msg.result[0];
      if (!c) return;
      const contract = msg.result[0].n ? String(msg.result[0].n).split('_').slice(1).join('_') : '';
      this.broadcast({
        type: 'candle',
        contract,
        instrument: instrumentOf(contract),
        bar: {
          time: Number(c.t),
          open: Number(c.o),
          high: Number(c.h),
          low: Number(c.l),
          close: Number(c.c),
          volume: Number(c.v),
          turnover: c.a == null ? undefined : Number(c.a),
          closed: c.w === true,
        },
      });
      return;
    }

    if (msg.channel === 'futures.tickers' && Array.isArray(msg.result)) {
      for (const t of msg.result as GateTicker[]) {
        this.broadcast({
          type: 'ticker',
          contract: t.contract,
          instrument: instrumentOf(t.contract),
          last: Number(t.last),
          mark: Number(t.mark_price),
          change24h: Number(t.change_percentage),
          fundingRate: Number(t.funding_rate),
          volume24hUsd: Number(t.volume_24h_quote),
        });
      }
      return;
    }

    if (msg.channel === 'futures.trades' && Array.isArray(msg.result)) {
      for (const t of msg.result as GateTrade[]) {
        this.broadcast({
          type: 'trade',
          contract: t.contract,
          instrument: instrumentOf(t.contract),
          price: Number(t.price),
          size: t.size,
          ts: t.create_time_ms,
        });
      }
    }
  }

  private broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const c of this.clients.values()) c.send(data);
  }

  status(): { alive: boolean; subscriptions: number; clients: number } {
    return { alive: this.alive, subscriptions: this.wanted.size, clients: this.clients.size };
  }

  close(): void {
    /**
     * 先摘监听再关：ws.close() 会触发 'close'，那个处理器会顺手安排一次重连 ——
     * 结果是「关掉了又自己连回来」。两个定时器也要清成 null，不然状态会一直显示成还挂着。
     */
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
    // 从 wss 上摘掉自己：换交易所会造一个新 hub，旧的不摘就会有两个都在往页面推
    this.wss.off('connection', this.onConn);
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
  }
}
