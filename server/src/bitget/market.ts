import type { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { WebSocket as UndiciWS } from 'undici';
import { wsDispatcherFor, wsRouteOrder } from '../net.js';
import { isStale, routeOnTrouble, type NetRoute } from '../wsRoute.js';

/** 官方行情地址。诊断时可以用 XF_WS_URL 指到别处（例如自建镜像） */
const WS_LIVE = (process.env.XF_WS_URL ?? '').trim() || 'wss://ws.bitget.com/v2/ws/public';
/** 时间相关的阈值也留了出口：本地调试要把它调小，不然得干等一分半 */
const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** 连上不到这么久就断，算「这条路在这台机器上不通」，换另一条 */
const FAST_FAIL_MS = envMs('XF_WS_FAST_FAIL_MS', 4000);
/** 多久没收到任何帧就当连接已经假死。心跳 25 秒一次，留足余量 */
const STALE_MS = envMs('XF_WS_STALE_MS', 90_000);
/** 建连最多等这么久。TUN 把路由黑洞掉时，握手会一直挂着，不能干等 */
const OPEN_TIMEOUT_MS = envMs('XF_WS_OPEN_TIMEOUT_MS', 12_000);

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

/** candle 频道 → 周期秒数。用来把推送的时间戳吸附到周期起点 */
const CANDLE_STEP: Record<string, number> = {
  candle1m: 60, candle5m: 300, candle15m: 900, candle30m: 1800,
  candle1H: 3600, candle4H: 14400, candle1D: 86_400,
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
  /** 现在走哪条路，以及在这条路上连栽了几次 */
  private route: NetRoute | null = null;
  private routeFails = 0;
  /** 最后收到一帧的时刻。TUN / 代理节点掉线时，TCP 常常还举着，只有数据停了 */
  private lastMessageAt = 0;
  private staleTimer: NodeJS.Timeout | null = null;
  /** 建连看门狗。放掉一条连接时也要把它清掉 */
  private openTimer: NodeJS.Timeout | null = null;

  /**
   * 这个 hub 已经作废（换交易所时会关掉旧的）。
   *
   * 关连接会触发 close 事件，那个处理器会顺手安排一次重连 —— 不认这个标记的话，
   * 「关掉」变成「500 毫秒后又连回来」，旧交易所的连接就一直在后台跑。
   * 对页面那侧的 wss 已经摘掉了，所以它推的东西没人接，纯属耗着。
   */
  private disposed = false;

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

  /**
   * 接上行情。
   *
   * 走哪条路不是写死的：配了代理时先按实测快慢排序（见 net.ts 的 wsRouteOrder），
   * 连上就记住这条路；如果反复「连上就断」，说明这条路在本机根本走不通
   * —— TUN 模式下系统代理还开着、或者节点不让连 WebSocket 时就是这样 ——
   * 换另一条再试。以前只在建连时挑一次，挑错就永远在同一个坑里重连。
   */
  /**
   * 放掉当前这条连接，然后重连 —— 不等对端回 close 帧。
   *
   * 关键是不拿 close() 当「已经关掉了」的信号。undici 的 WebSocket，close() 只是
   * 写一个 CLOSE 帧、把状态标成 CLOSING；真正的 'close' 事件要等底层 TCP 关。
   * 而假死恰恰是「TCP 还举着、对端一个字节都不回」—— 代理节点掉了、TUN 把路由
   * 黑洞掉的时候就是这样，连这个 CLOSE 帧也没人回。
   *
   * 所以只写一句 close() 然后等事件的话：
   *   · 'close' 可以几分钟都不来（TCP 重传超时之前它不会动）；
   *   · this.ws 还是非空 —— connect() 一看就当场返回；
   *   · 结果是看门狗把自己关进 CLOSING 里，行情再也回不来；
   *   · 换路记账也不会发生（它在 close 处理器里）。
   *
   * 这里改成先把 this.ws 让出来再尽力关一次，然后自己排重连。让出来的那条连接
   * 上还挂着监听，那些处理器第一件事就是比 this.ws !== sock，比不上的直接走开：
   * 不广播、不排重连，也不会把这时已经建好的新连接清掉。
   */
  private abandon(reason: string): void {
    const sock = this.ws;
    if (!sock) return;
    const uptime = this.openedAt > 0 ? Date.now() - this.openedAt : 0;
    this.ws = null;
    this.alive = false;
    this.clearClocks();
    try { sock.close(); } catch { /* 已经断了，关不掉也无妨 */ }
    console.warn('[ws] bitget ' + reason + '，放掉这条连接重连（uptime=' + uptime + 'ms）');
    // 页面靠这一条把「行情断了」显示出来。名字沿用 gate_down：前端只认它
    this.broadcast({ type: 'gate_down' });
    this.scheduleReconnect();
  }

  /** 三个定时器一起清：换连接、放掉连接、关 hub 都要清干净，少清一个就多一条连接 */
  private clearClocks(): void {
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null; }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
  }

  connect(): void {
    if (this.disposed || this.ws) return;
    let order = wsRouteOrder();
    let preferred: NetRoute = this.route && order.includes(this.route) ? this.route : order[0]!;
    let dispatcher = wsDispatcherFor(preferred);
    /**
     * 说好走代理，手上却没有代理 agent（代理刚好在这一刻被判死）。
     *
     * 这一轮就整轮按直连算：日志别写「走代理」，换路记账也别再把「代理」当成另一条 ——
     * 否则关连接时会按旧顺序切回一个根本不存在的代理，白等一轮超时。
     */
    if (preferred === 'proxy' && !dispatcher) {
      order = ['direct'];
      preferred = 'direct';
      dispatcher = null;
    }
    const route: NetRoute = preferred;
    this.route = route;
    const sock = dispatcher
      ? new UndiciWS(WS_LIVE, { dispatcher } as unknown as string[])
      : new UndiciWS(WS_LIVE);
    this.ws = sock;

    // 建连看门狗：到点还没 open 就当作这条路不通，自己兜一次重连
    this.openTimer = setTimeout(() => {
      if (this.disposed || this.alive || this.ws !== sock) return;
      // 握手都建不起来，这条路基本可以直接判死：算两次，当场换路，别再多等一轮
      this.noteTrouble(order, route, 2);
      this.abandon('握手 ' + Math.round(OPEN_TIMEOUT_MS / 1000) + ' 秒没建起来 route=' + route);
    }, OPEN_TIMEOUT_MS);
    this.openTimer.unref();

    sock.addEventListener('open', () => {
      // 这条已经被放掉了（握手超时之后又连上了）：别去动那时的新连接
      if (this.disposed || this.ws !== sock) return;
      if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null; }
      this.alive = true;
      this.openedAt = Date.now();
      this.lastMessageAt = Date.now();
      this.reconnectAttempt = 0;
      this.routeFails = 0;
      console.log('[ws] bitget connected' + (dispatcher ? '（走代理）' : '（直连）'));
      for (const sub of this.wanted.values()) this.sendSub('subscribe', sub);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        // Bitget 的心跳是一个裸字符串，不是 JSON
        if (this.ws === sock && sock.readyState === OPEN) sock.send('ping');
      }, PING_MS);
      this.heartbeat.unref();
      /**
       * 假死看门狗：还「连着」但一帧都没有，就把这条连接放掉重来。
       * TUN 模式掉线时 TCP 常常还举着，不看数据的话页面会一直停在「已连接」的旧行情上。
       */
      if (this.staleTimer) clearInterval(this.staleTimer);
      this.staleTimer = setInterval(() => {
        if (this.ws !== sock || sock.readyState !== OPEN) return;
        const now = Date.now();
        // 一个订阅都没有时，服务端本来就不推东西，别把它当成假死
        if (!isStale({ now, lastMessageAt: this.lastMessageAt, staleMs: STALE_MS, subscriptions: this.wanted.size })) return;
        /**
         * 这里不能只写一句 close()：对端不回关闭帧的时候 'close' 事件永远不来，
         * 这条连接就一直挂在 CLOSING 上，而 connect() 因为 this.ws 非空不会再连。
         * 见上面 abandon() 那段。
         */
        this.abandon('已 ' + Math.round((now - this.lastMessageAt) / 1000) + ' 秒没有任何数据');
      }, Math.min(15_000, Math.max(1000, Math.round(STALE_MS / 6))));
      this.staleTimer.unref();
    });

    // 交易所偶尔会推形状不对的帧，不兜住会把进程带走
    sock.addEventListener('message', (ev) => {
      // 放掉的那条连接可能还会冒出几帧：那不是当前行情，别拿来广播
      if (this.ws !== sock) return;
      this.lastMessageAt = Date.now();
      try {
        const data = (ev as unknown as { data: unknown }).data;
        const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
        this.onMessage(text);
      } catch (err) {
        console.warn('[ws] 解析行情帧失败:', err instanceof Error ? err.message : String(err));
      }
    });

    sock.addEventListener('close', (ev) => {
      // 这条已经被放掉了（abandon 已经排过重连），它迟到的 close 什么都不该做
      if (this.ws !== sock) return;
      this.alive = false;
      this.ws = null;
      this.clearClocks();
      const uptime = Date.now() - this.openedAt;
      const close = ev as unknown as { code?: number; reason?: string };
      console.warn(
        '[ws] bitget closed uptime=' + uptime + 'ms'
        + ' route=' + (route === 'proxy' ? 'proxy' : 'direct')
        + (close?.code ? ' code=' + close.code : '')
        + (close?.reason ? ' reason=' + close.reason : ''),
      );
      /**
       * 连上就断：这条路在本机走不通。
       *
       * TUN 模式最容易撞上这一条：注册表里系统代理还开着，REST 走代理没问题，
       * 但 WebSocket 经代理连出去会被节点掐掉，于是「连上 → 秒断 → 重连」循环。
       * 连续两次就换另一条路，别在同一条路上原地打转。
       */
      if (uptime < FAST_FAIL_MS) this.noteTrouble(order, route);
      if (this.disposed) return;
      // 页面靠这一条把「行情断了」显示出来。名字沿用 gate_down：前端只认它
      this.broadcast({ type: 'gate_down' });
      this.scheduleReconnect();
    });

    sock.addEventListener('error', () => {
      console.warn('[ws] bitget 连接出错 route=' + (route === 'proxy' ? 'proxy' : 'direct') + '（直连被重置？换一条路会自动重试）');
    });
  }

  /**
   * 这条路又栽了一次：连着栽两次就换另一条。
   *
   * 只在「有另一条可换」时才动：没配代理的时候直连不通就是不通，换也换不出东西来。
   */
  private noteTrouble(order: NetRoute[], route: NetRoute, weight = 1): void {
    const outcome = routeOnTrouble(order, route, this.routeFails, weight);
    this.routeFails = outcome.fails;
    if (!outcome.switched) return;
    this.route = outcome.route;
    console.warn('[ws] bitget 连续两次连不上，换 ' + (outcome.route === 'proxy' ? '代理' : '直连') + ' 再试');
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
      const step = CANDLE_STEP[channel] ?? 0;
      for (const row of data) {
        if (!Array.isArray(row)) continue;
        const raw = Math.round(Number(row[0]) / 1000);
        if (!Number.isFinite(raw) || raw <= 0) continue;
        /**
         * Bitget 推的「正在走的那根」时间戳是**当前分钟**，不是周期起点：
         * 订阅 5m 时，20:29 会来一根 time=20:29 的帧。页面按时间合并，
         * 于是 5 分钟图里每分钟多出一根「幽灵 K 线」—— 图上一段一段断开、
         * 每多一根就触发一次跟随位移和价格轴重算，看着就是上下抽搐。
         * 统一吸附到周期网格再广播。
         */
        const t = step > 0 ? Math.floor(raw / step) * step : raw;
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
    /**
     * 先立「作废」标记再关。
     *
     * 关连接会走 close 处理器，它本来会顺手安排一次重连 —— 靠这个标记，加上
     * 「this.ws 已经不是那条连接」那道判断，让那个处理器什么都不做，否则关了又自己连回来。
     */
    this.disposed = true;
    this.alive = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearClocks();
    // 从 wss 上摘掉自己：换交易所会造一个新 hub，旧的不摘就会有两个都在往页面推
    this.wss.off('connection', this.onConn);
    const sock = this.ws;
    this.ws = null;
    try { sock?.close(); } catch { /* 已经断了 */ }
  }
}
