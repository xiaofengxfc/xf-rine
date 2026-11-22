/**
 * 长连接（行情 WebSocket）走哪条路：纯函数，不碰网络、不碰全局状态。
 *
 * 抽出来是因为这块最容易出错，而错法又很难在真实网络里稳定复现：
 * 「代理配着但长连接被节点掐掉」「TUN 把路由黑洞掉」「连上了却一帧不来」。
 * 真正的破绽都在判断上，所以判断本身要能单独测（server/scripts/check-ws-route.ts）。
 */

export type NetRoute = 'direct' | 'proxy';

export interface RouteStats {
  /** 直连一次请求花了多少毫秒，0 = 还没量到 */
  direct: number;
  /** 代理一次请求花了多少毫秒，0 = 还没量到 */
  proxy: number;
}

/** 连着栽几次就换路 */
export const SWITCH_AFTER_FAILS = 2;

/**
 * 候选路，排好序。
 *
 * 没配代理就只有直连这一条 —— 换也换不出东西来。
 * 配了代理时按 REST 实测的快慢排：能出网的那条通常也是长连接能用的那条。
 * forced 是人工指定的优先项（XF_WS_ROUTE），只排到最前，另一条仍是后备。
 */
export function orderRoutes(
  stats: RouteStats,
  proxyOn: boolean,
  forced = '',
): NetRoute[] {
  if (!proxyOn) return ['direct'];
  const { direct: d, proxy: p } = stats;
  let order: NetRoute[];
  if (d > 0 && p > 0) order = d <= p ? ['direct', 'proxy'] : ['proxy', 'direct'];
  else if (d > 0) order = ['direct', 'proxy'];
  else if (p > 0) order = ['proxy', 'direct'];
  // 两条都还没量到：配了代理说明大概率是因为直连不通才配的，先试代理
  else order = ['proxy', 'direct'];

  if (forced === 'direct' || forced === 'proxy') {
    order = [forced, ...order.filter((route) => route !== forced)];
  }
  return order;
}

export interface TroubleOutcome {
  route: NetRoute;
  fails: number;
  /** 这一次真的换路了 */
  switched: boolean;
}

/**
 * 这条路又栽了一次之后，下一步走哪条。
 *
 * weight = 2 表示「这次失败足够说明这条路不能用」（比如握手 12 秒都没建起来），
 * 当场就换，不必再赔一轮重连。
 */
export function routeOnTrouble(
  order: NetRoute[],
  route: NetRoute,
  fails: number,
  weight = 1,
): TroubleOutcome {
  if (order.length < 2) return { route, fails: 0, switched: false };
  const next = fails + weight;
  if (next < SWITCH_AFTER_FAILS) return { route, fails: next, switched: false };
  const idx = order.indexOf(route);
  // 只可能在 order 里（调用方就是这么选的）。不在里面就当第一条是「另一条」
  const fallback: NetRoute = order[(Math.max(0, idx) + 1) % order.length] ?? 'direct';
  return { route: fallback === route ? (order[0] ?? 'direct') : fallback, fails: 0, switched: true };
}

/**
 * 连接是不是已经假死。
 *
 * TUN、代理节点掉线时 TCP 常常还举着：连接状态是 OPEN，但一帧都不来。
 * 只看 readyState 的话，页面会停在「已连接」的旧行情上，比直接断线更糟。
 *
 * 没有任何订阅时不算假死 —— 服务端本来就不推东西。
 */
export function isStale(input: {
  now: number;
  lastMessageAt: number;
  staleMs: number;
  subscriptions: number;
}): boolean {
  if (input.subscriptions <= 0) return false;
  if (input.lastMessageAt <= 0) return false;
  return input.now - input.lastMessageAt >= input.staleMs;
}
