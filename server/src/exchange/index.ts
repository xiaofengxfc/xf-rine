import WebSocket, { type WebSocketServer } from 'ws';
import { config } from '../config.js';
import type { Exchange, MarketHub } from './types.js';
import { GateExchange } from './gate.js';
import { BitgetExchange } from '../bitget/adapter.js';

/**
 * 当前用哪家交易所。
 *
 * 二选一，不是「同时连两家」：合约名、张数、持仓、挂单、保护单，整个台子的口径
 * 都绑在这一个选择上。同时接两家会让「这个价格是哪家的」「这个仓在哪下单」
 * 变成每一步都要问一遍的问题，而那种模糊最后一定算在钱上。
 *
 * 实例会留着（缓存合约表、合约乘数），但配置一改，下次调用就会拿到新的那家。
 */

let gateInstance: GateExchange | null = null;
let bitgetInstance: BitgetExchange | null = null;
let hub: MarketHub | null = null;
let hubWss: WebSocketServer | null = null;

export function exchange(): Exchange {
  if (config.exchange === 'bitget') {
    if (!bitgetInstance) bitgetInstance = new BitgetExchange();
    return bitgetInstance;
  }
  if (!gateInstance) gateInstance = new GateExchange();
  return gateInstance;
}

/**
 * 页面到服务端这一跳的心跳。
 *
 * 页面那颗「行情已连接」不能只看 readyState：代理节点掉线、TUN 黑洞、手机切前后台之后，
 * TCP 常常还举着，连接状态是 OPEN 却一帧都不来 —— 页面就绿着、K 线不动，只能刷新。
 * 每 10 秒推一条心跳，页面据此判断「多久没消息」，超时自己重连（见 web 的 useMarketFeed）。
 *
 * 挂在 wss 上而不是 hub 上：换交易所会造一个新 hub，心跳不该跟着一起换。
 */
const CLIENT_HEARTBEAT_MS = 10_000;
let clientHeartbeat: NodeJS.Timeout | null = null;

/** 启动时接上行情连接。它跟着当前交易所走，页面那侧的协议是同一套 */
export function attachMarketHub(wss: WebSocketServer): void {
  hubWss = wss;
  hub = exchange().marketHub(wss);
  hub.connect();
  if (clientHeartbeat) clearInterval(clientHeartbeat);
  clientHeartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // 这一条可能正好在处理关闭：send 会抛，抛出去就会把心跳定时器带走
      try { client.send('{"type":"ping"}'); } catch { /* 已经断了 */ }
    }
  }, CLIENT_HEARTBEAT_MS);
  clientHeartbeat.unref();
}

export function marketHubStatus(): { alive: boolean; subscriptions: number; clients: number } {
  return hub?.status() ?? { alive: false, subscriptions: 0, clients: 0 };
}

export function closeMarketHub(): void {
  hub?.close();
  hub = null;
}

/**
 * 换过交易所之后，旧那家的缓存不该再被拿去算账。
 *
 * 行情连接也得换：两家的 K 线频道名、合约名、地址全不一样，留着旧的等于
 * 页面上一半数据是 Gate、一半是 Bitget。已经在线的页面直接断开让它们重连一次 ——
 * 重连会按新交易所重新订阅，比悄悄喂错数据强。
 */
export function resetExchangeCache(): void {
  gateInstance = null;
  bitgetInstance = null;
  closeMarketHub();
  if (hubWss) {
    for (const client of hubWss.clients) {
      try { client.terminate(); } catch { /* 已经断了 */ }
    }
    hub = exchange().marketHub(hubWss);
    hub.connect();
  }
}

export type { Exchange } from './types.js';
