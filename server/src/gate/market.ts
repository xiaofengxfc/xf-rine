import WebSocket from 'ws';
import type { WebSocketServer } from 'ws';
import { marketWsUrl } from '../config.js';

export interface GateCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: number;
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

  constructor(private wss: WebSocketServer) {
    this.wss.on('connection', (sock) => {
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
    });
  }

  private onClientMessage(client: Client, raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type === 'subscribe' && typeof msg.contract === 'string') {
      const contract = msg.contract.replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 32);
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
    });

    // 交易所偶尔会推形状不对的帧。不兜住的话异常会冒到事件循环上把进程带走 ——
    // 页面还开着，数据却停在那一刻，看起来就像「均价跑到别处去了」。
    ws.on('message', (buf) => {
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
        bar: {
          time: Number(c.t),
          open: Number(c.o),
          high: Number(c.h),
          low: Number(c.l),
          close: Number(c.c),
          volume: Number(c.v),
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
    this.ws = null;
  }
}
