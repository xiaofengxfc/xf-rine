import type { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { WebSocket as UndiciWS } from 'undici';
import { wsDispatcher } from '../net.js';

/**
 * Bitget 公共行情连接。
 *
 * 对页面暴露的协议和 gate/market.ts 完全一样（subscribe / candle / ticker / trade /
 * gate_down）—— 前端只认这一套，换交易所不该让页面再学一门语言。
 *
 * 和 Gate 的几处不同：
 *   · 订阅是一条 op/args 消息，频道名写成 candle4H / ticker / trade，instId 用 BTCUSDT；
 *   · 心跳是发一个裸字符串 "ping"（不是 JSON），服务端回 "pong"；
 *   · 断线重连后要把当前所有在用的频道重订一遍，否则页面看着「连着但数据不动」；
 *   · **上游用 undici 的 WebSocket，不用 ws 库**：ws 不读系统代理，而这个网络里
 *     bitget 的 WS 直连会被重置，只有跟着 REST 那条代理走出去才连得上。
 *     对页面那侧仍然是 ws 的 WebSocketServer，协议不变。
 *
 * 公开行情始终使用主网地址。模拟账户的公开 REST K 线也是主网行情，wspap 上的
 * candle 订阅虽会确认成功，但不会推送行情帧。
 */

const WS_LIVE = 'wss://ws.bitget.com/v2/ws/public';
const PRODUCT = 'USDT-FUTURES';
/** 官方限制是 5 秒内最多 10 条 ping，这里宽松到 25 秒一次 */
const PING_MS = 25_000;
/** undici 的 WebSocket 每个实例自带常量，这里用数字省得比较两套枚举 */
const OPEN = 1;

/** 页面上的周期 → Bitget 的频道后缀 */
const CHANNEL_TF: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '4h': '4H', '1d': '1D',
};

/** BTC_USDT → BTCUSDT */
function symbolOf(name: string): string {
  return String(name ?? '').toUpperCase().replace(/_/g, '');
}

/** BTCUSDT → BTC_USDT */
function nameOf(symbol: string): string {
  const s = String(symbol ?? '').toUpperCase();
  return s.endsWith('USDT') && !s.includes('_') ? s.slice(0, -4) + '_USDT' : s;
}

type Client = { id: number; send: (data: string) => void };
type Sub = { channel: string; instId: string; refs: Set<number> };

export class BitgetMarketHub {
  private ws: UndiciWS | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private wanted = new Map<string, Sub>();
  private clients = new Map<number, Client>();
  private nextClientId = 1;
  private alive = false;
  private openedAt = 0;

  /** 存一份监听函数：换交易所时要把旧 hub 从 wss 上摘掉，否则两条连接都在跑 */
  private onConn: (sock: WebSocket) => void;

  constructor(private wss: WebSocketServer) {
    this.onConn = (sock: WebSocket) => {
      const id = this.nextClientId++;
      const client: Client = {
        id,
        send: (data) => { if (sock.readyState === WebSocket.OPEN) sock.send(data); },
      };
      this.clients.set(id, client);
      sock.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
      sock.on('message', (rawMsg) => {
        try {
          this.onClientMessage(client, rawMsg.toString());
        } catch (err) {
          console.warn('[ws] 解析客户端消息失败:', err instanceof Error ? err.message : String(err));
        }
      });
      sock.on('close', () => {
        this.clients.delete(id);
        for (const [key, sub] of [...this.wanted]) {
          if (sub.refs.delete(id) && sub.refs.size === 0) {
            this.sendSub('unsubscribe', sub);
            this.wanted.delete(key);
          }
        }
      });
    };
    this.wss.on('connection', this.onConn);
  }

  private onClientMessage(client: Client, rawMsg: string): void {
    let msg: any;
    try { msg = JSON.parse(rawMsg); } catch { return; }
    if (msg?.type !== 'subscribe' || typeof msg.contract !== 'string') return;
    // 合约名只挡控制字符和空白；长度按交易所上限截
    const contract = String(msg.contract).replace(/[\u0000-\u001f\u007f\s]/g, '').slice(0, 40);
    const interval = typeof msg.interval === 'string' && CHANNEL_TF[msg.interval] ? msg.interval : '1m';
    const instId = symbolOf(contract);
    // 单连接只保持一组订阅，切合约时先退旧的
    this.dropAllRefs(client.id);
    this.addWanted(client.id, 'candles:' + interval + ':' + instId, 'candle' + (CHANNEL_TF[interval] ?? '1m'), instId);
    this.addWanted(client.id, 'trades:' + instId, 'trade', instId);
    this.addWanted(client.id, 'tickers:' + instId, 'ticker', instId);
    client.send(JSON.stringify({ type: 'subscribed', contract, interval }));
  }

  private dropAllRefs(clientId: number): void {
    for (const [key, sub] of [...this.wanted]) {
      if (sub.refs.delete(clientId) && sub.refs.size === 0) {
        this.sendSub('unsubscribe', sub);
        this.wanted.delete(key);
      }
    }
  }

  private addWanted(clientId: number, key: string, channel: string, instId: string): void {
    let sub = this.wanted.get(key);
    if (!sub) {
      sub = { channel, instId, refs: new Set() };
      this.wanted.set(key, sub);
      this.sendSub('subscribe', sub);
    }
    sub.refs.add(clientId);
  }

  private sendSub(op: 'subscribe' | 'unsubscribe', sub: Sub): void {
    if (!this.ws || this.ws.readyState !== OPEN) return;
    this.ws.send(JSON.stringify({
      op,
      args: [{ instType: PRODUCT, channel: sub.channel, instId: sub.instId }],
    }));
  }

  connect(): void {
    if (this.ws) return;
    const dispatcher = wsDispatcher();
    const sock = dispatcher
      ? new UndiciWS(WS_LIVE, { dispatcher } as unknown as string[])
      : new UndiciWS(WS_LIVE);
    this.ws = sock;

    sock.addEventListener('open', () => {
      this.alive = true;
      this.openedAt = Date.now();
      this.reconnectAttempt = 0;
      console.log('[ws] bitget connected' + (dispatcher ? '（走代理）' : ''));
      for (const sub of this.wanted.values()) this.sendSub('subscribe', sub);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        // Bitget 的心跳是一个裸字符串，不是 JSON
        if (this.ws && this.ws.readyState === OPEN) this.ws.send('ping');
      }, PING_MS);
      this.heartbeat.unref();
    });

    // 交易所偶尔会推形状不对的帧，不兜住会把进程带走
    sock.addEventListener('message', (ev) => {
      try {
        const data = (ev as unknown as { data: unknown }).data;
        const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
        this.onMessage(text);
      } catch (err) {
        console.warn('[ws] 解析行情帧失败:', err instanceof Error ? err.message : String(err));
      }
    });

    sock.addEventListener('close', () => {
      this.alive = false;
      this.ws = null;
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      console.warn('[ws] bitget closed uptime=' + (Date.now() - this.openedAt) + 'ms');
      // 页面靠这一条把「行情断了」显示出来。名字沿用 gate_down：前端只认它
      this.broadcast({ type: 'gate_down' });
      this.scheduleReconnect();
    });

    sock.addEventListener('error', () => { console.warn('[ws] bitget 连接出错（直连被重置？配了代理就会走代理）'); });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onMessage(rawMsg: string): void {
    // 心跳回应不是 JSON
    if (rawMsg === 'pong') return;
    let msg: any;
    try { msg = JSON.parse(rawMsg); } catch { return; }
    if (msg?.event === 'error') {
      console.warn('[ws] bitget 订阅报错：' + String(msg.msg ?? msg.code ?? ''));
      return;
    }
    const arg = msg?.arg ?? {};
    const channel = String(arg.channel ?? '');
    const instId = String(arg.instId ?? '');
    const contract = nameOf(instId);
    const data = Array.isArray(msg?.data) ? msg.data : [];
    if (!channel || data.length === 0) return;

    if (channel.startsWith('candle')) {
      for (const row of data) {
        if (!Array.isArray(row)) continue;
        const t = Math.round(Number(row[0]) / 1000);
        if (!Number.isFinite(t) || t <= 0) continue;
        this.broadcast({
          type: 'candle',
          contract,
          bar: {
            time: t,
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
            turnover: row[6] == null ? undefined : Number(row[6]),
            // 推送里没有「这根走完没有」，交给页面按时间判断
            closed: false,
          },
        });
      }
      return;
    }

    if (channel === 'ticker') {
      for (const t of data) {
        const last = Number(t?.lastPr);
        if (!Number.isFinite(last) || last <= 0) continue;
        this.broadcast({
          type: 'ticker',
          contract: nameOf(String(t?.instId ?? instId)),
          last,
          mark: Number(t?.markPrice ?? last),
          // Bitget 给的是比例，页面要的是百分数
          change24h: Number(t?.change24h ?? 0) * 100,
          fundingRate: Number(t?.fundingRate ?? 0),
          volume24hUsd: Number(t?.quoteVolume ?? 0),
        });
      }
      return;
    }

    if (channel === 'trade') {
      for (const t of data) {
        const price = Number(t?.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        this.broadcast({
          type: 'trade',
          contract: nameOf(String(t?.instId ?? instId)),
          price,
          size: Number(t?.size ?? 0),
          ts: Number(t?.ts ?? Date.now()),
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
    // 先摘监听再关：close 事件会顺手安排一次重连，那就变成「关了又自己连回来」
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    // 从 wss 上摘掉自己：换交易所会造一个新 hub，旧的不摘就会有两个都在往页面推
    this.wss.off('connection', this.onConn);
    this.ws?.close();
    this.ws = null;
  }
}
