import { ApiError, json, toResponse } from './errors';
import { gateClient } from './gate';
import { bitgetClient } from './bitget';
import { isSizeOnStep } from './sizing';
import type { Client, ContractInfo, Direction, Env, OrderInput, PriceOrder, TriggerInput } from './types';

/**
 * Cloudflare Worker：手机直连交易所的那一套后端。
 *
 * 它只做「交易所 + 交易」这件事。关键位引擎是 Python、AI 分析和量化回测要跑很久，
 * 这些在 Worker 里都跑不了 —— 对应的接口直接回 501/503，页面会显示「这套连接下没有」，
 * 而不是假装成功。
 *
 * 密钥全部来自 Worker secrets，不经过手机：
 *   wrangler secret put GATE_KEY / GATE_SECRET
 *   wrangler secret put BITGET_KEY / BITGET_SECRET / BITGET_PASSPHRASE
 *   wrangler secret put REMOTE_TOKEN          ← 手机连 Worker 用的口令
 */

export interface Env2 {
  EXCHANGE?: string;
  GATE_ENV?: string;
  GATE_KEY?: string;
  GATE_SECRET?: string;
  BITGET_KEY?: string;
  BITGET_SECRET?: string;
  BITGET_PASSPHRASE?: string;
  LIVE_TRADING?: string;
  REMOTE_TOKEN?: string;
  MAX_NOTIONAL?: string;
  ARM: DurableObjectNamespace;
}

/** 解锁令牌：Worker 自己无状态，得放在 Durable Object 里才认得出「刚才是本人解锁的」 */
export class ArmRoom {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/issue') {
      const token = crypto.randomUUID().replace(/-/g, '');
      await this.state.storage.put('token', token);
      return json({ token });
    }
    if (url.pathname === '/verify') {
      const given = url.searchParams.get('token') ?? '';
      const cur = await this.state.storage.get<string>('token');
      return json({ ok: Boolean(cur) && cur === given });
    }
    if (url.pathname === '/clear') {
      await this.state.storage.delete('token');
      return json({ ok: true });
    }
    return json({ error: 'NO_ROUTE' }, 404);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type, x-arm-token, x-remote-token',
  'Access-Control-Max-Age': '600',
};

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

function clientOf(env: Env2): Client {
  const which = (env.EXCHANGE ?? 'gate').trim().toLowerCase();
  const mode: Env = (env.GATE_ENV ?? 'live').trim().toLowerCase() === 'testnet' ? 'testnet' : 'live';
  if (which === 'bitget') {
    return bitgetClient({
      env: mode,
      key: env.BITGET_KEY ?? '',
      secret: env.BITGET_SECRET ?? '',
      passphrase: env.BITGET_PASSPHRASE ?? '',
    });
  }
  return gateClient({ env: mode, key: env.GATE_KEY ?? '', secret: env.GATE_SECRET ?? '' });
}

async function armFetch(env: Env2, path: string): Promise<any> {
  const id = env.ARM.idFromName('singleton');
  const stub = env.ARM.get(id);
  const res = await stub.fetch('https://arm' + path);
  return res.json();
}

async function requireArm(env: Env2, req: Request): Promise<void> {
  const token = req.headers.get('x-arm-token') ?? '';
  if (!token) throw new ApiError(403, 'NOT_ARMED', '交易没解锁：先点右上角「解锁交易」');
  const r = await armFetch(env, '/verify?token=' + encodeURIComponent(token));
  if (!r?.ok) throw new ApiError(403, 'NOT_ARMED', '解锁已经失效（服务重启或换过设备），重新点一次「解锁交易」');
}

function notionalCap(env: Env2): number {
  const n = Number(env.MAX_NOTIONAL);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/**
 * 止损止盈。
 *
 * 和服务端一样的顺序：先撤这一边旧的保护单，再挂新的。
 * 想挂的没挂上就明说 —— 只挂上一边也算部分失败，不能报「成功」。
 */
async function applyBracket(c: Client, contract: string, dir: Direction, stop: number, target: number): Promise<{
  created: { kind: string; id: string; triggerPrice: number }[];
  canceled: string[];
  errors: string[];
}> {
  const created: { kind: string; id: string; triggerPrice: number }[] = [];
  const canceled: string[] = [];
  const errors: string[] = [];

  const mine = (await c.triggers().catch(() => [] as PriceOrder[])).filter(
    (t) => t.protective && t.contract === contract && (t.direction === dir || t.direction === ''),
  );
  for (const t of mine) {
    try {
      await c.cancelTrigger(t.id);
      canceled.push(t.id);
    } catch (e) {
      errors.push('撤旧单 ' + t.id + '：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  const jobs: { kind: 'stop' | 'target'; price: number }[] = [];
  if (stop > 0) jobs.push({ kind: 'stop', price: stop });
  if (target > 0) jobs.push({ kind: 'target', price: target });
  for (const job of jobs) {
    try {
      const r = await c.placeTrigger({ contract, direction: dir, role: job.kind, price: job.price });
      created.push({ kind: job.kind, id: r.id, triggerPrice: job.price });
    } catch (e) {
      errors.push(job.kind + '：' + (e instanceof Error ? e.message : String(e)));
    }
  }
  return { created, canceled, errors };
}

/** 开仓之后补挂保护：市价单成交要一点时间，等它一下 */
async function attachAfterEntry(c: Client, contract: string, dir: Direction, stop: number, target: number) {
  for (let i = 0; i < 3; i += 1) {
    const sides = await c.positions().catch(() => []);
    if (sides.some((p) => p.contract === contract && p.direction === dir && p.size > 0)) {
      try {
        const r = await applyBracket(c, contract, dir, stop, target);
        return { status: r.errors.length > 0 ? ('partial' as const) : ('attached' as const), ...r };
      } catch (e) {
        return { status: 'failed' as const, error: e instanceof Error ? e.message : String(e) };
      }
    }
    if (i < 2) await new Promise((done) => setTimeout(done, 250));
  }
  return { status: 'pending' as const };
}

async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    const text = await req.text();
    return text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    throw new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
}

const numOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function validateOrderSize(size: number, info: ContractInfo): void {
  if (!(size > 0) || !Number.isFinite(size)) throw new ApiError(400, 'BAD_INPUT', '张数不对');
  if (size < info.sizeMin) throw new ApiError(400, 'SIZE_TOO_SMALL', '张数至少 ' + info.sizeMin + ' 张');
  if (info.sizeMax > 0 && size > info.sizeMax) throw new ApiError(400, 'SIZE_TOO_BIG', '张数最多 ' + info.sizeMax + ' 张');
  if (!isSizeOnStep(size, info.sizeStep)) throw new ApiError(400, 'SIZE_STEP', '张数必须按 ' + info.sizeStep + ' 张递增');
}

export default {
  async fetch(req: Request, env: Env2): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

    try {
      const c = clientOf(env);
      const needsKeys = !path.startsWith('/api/health') && !path.startsWith('/api/tickers')
        && !path.startsWith('/api/candles') && !path.startsWith('/api/contracts');

      // 口令：Worker 直接拿着交易所的密钥，不能裸奔
      const want = (env.REMOTE_TOKEN ?? '').trim();
      if (!want) {
        return withCors(json({ error: 'NO_TOKEN', detail: 'Worker 还没设口令：wrangler secret put REMOTE_TOKEN' }, 503));
      }
      if (req.headers.get('x-remote-token') !== want) {
        return withCors(json({ error: 'BAD_TOKEN', detail: '口令不对：设置页里的「服务器口令」要和 Worker 上的 REMOTE_TOKEN 一致' }, 403));
      }
      void needsKeys;

      // ---------- 行情 ----------
      if (path === '/api/health') {
        return withCors(json({ ok: true, exchange: c.id, env: (env.GATE_ENV ?? 'live'), worker: true, at: Date.now() }));
      }
      if (path === '/api/config') {
        const mode = (env.GATE_ENV ?? 'live').trim().toLowerCase() === 'testnet' ? 'testnet' : 'live';
        const configured = c.id === 'bitget'
          ? Boolean(env.BITGET_KEY && env.BITGET_SECRET && env.BITGET_PASSPHRASE)
          : Boolean(env.GATE_KEY && env.GATE_SECRET);
        return withCors(json({
          exchange: c.id,
          exchangeLabel: c.label,
          intervals: c.intervals,
          env: mode,
          envLabel: mode === 'testnet' ? '模拟盘' : '实盘',
          restBaseUrl: c.restBaseUrl,
          keys: { configured, hint: configured ? '已配置' : '没配' },
          keysByEnv: { testnet: { configured: false, hint: '' }, live: { configured, hint: configured ? '已配置' : '没配' } },
          liveTrading: String(env.LIVE_TRADING ?? 'false').toLowerCase() === 'true',
          ai: { configured: false, baseUrl: '', model: '', hint: 'Cloudflare Worker 这套连接没有 AI 分析' },
          local: false,
          worker: true,
          maxNotional: notionalCap(env),
        }));
      }
      if (path === '/api/tickers') {
        return withCors(json(await c.tickers()));
      }
      const mContract = /^\/api\/contracts\/([^/]+)$/.exec(path);
      if (mContract) {
        const name = decodeURIComponent(mContract[1]!);
        const list = await c.contracts();
        const hit = list.find((x) => x.name === name);
        if (!hit) throw new ApiError(404, 'NO_CONTRACT', '没有 ' + name + ' 这个合约');
        return withCors(json(hit));
      }
      if (path === '/api/candles') {
        const contract = url.searchParams.get('contract') ?? 'BTC_USDT';
        const interval = url.searchParams.get('interval') ?? '15m';
        const limit = Math.max(1, Math.min(1000, numOf(url.searchParams.get('limit')) || 500));
        const before = numOf(url.searchParams.get('before'));
        const bars = await c.candles(contract, interval, limit, before > 0 ? before : undefined);
        return withCors(json({
          contract, interval, bars,
          hasMore: bars.length >= limit,
          exhausted: bars.length < limit,
          gap: false,
        }));
      }

      // ---------- 账户与交易 ----------
      if (path === '/api/private-state') {
        // 账户、持仓、委托和保护单权限相互独立；某一项失败时保留其他成功数据。
        const [accountResult, positionsResult, ordersResult, priceOrdersResult] = await Promise.allSettled([
          c.account(), c.positions(), c.orders(), c.triggers(),
        ]);
        const describe = (result: PromiseRejectedResult): string => {
          const error = result.reason;
          return error instanceof ApiError
            ? `${error.label}: ${error.detail}`
            : error instanceof Error ? error.message : String(error);
        };
        const errors = {
          ...(accountResult.status === 'rejected' ? { account: describe(accountResult) } : {}),
          ...(positionsResult.status === 'rejected' ? { positions: describe(positionsResult) } : {}),
          ...(ordersResult.status === 'rejected' ? { orders: describe(ordersResult) } : {}),
          ...(priceOrdersResult.status === 'rejected' ? { priceOrders: describe(priceOrdersResult) } : {}),
        };
        const token = req.headers.get('x-arm-token') ?? '';
        const armed = token ? Boolean((await armFetch(env, '/verify?token=' + encodeURIComponent(token))).ok) : false;
        return withCors(json({
          ...(accountResult.status === 'fulfilled' ? { account: accountResult.value } : {}),
          ...(positionsResult.status === 'fulfilled' ? { positions: positionsResult.value } : {}),
          ...(ordersResult.status === 'fulfilled' ? { orders: ordersResult.value } : {}),
          ...(priceOrdersResult.status === 'fulfilled' ? { priceOrders: priceOrdersResult.value } : {}),
          ...(Object.keys(errors).length > 0 ? { errors } : {}),
          armed,
        }));
      }

      if (path === '/api/trade/arm' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.on === false) {
          await armFetch(env, '/clear');
          return withCors(json({ armed: false }));
        }
        // 实盘多要一道确认：和本机那套一样，开关没打开就不给令牌
        if (String(env.LIVE_TRADING ?? 'false').toLowerCase() !== 'true') {
          throw new ApiError(403, 'LIVE_OFF', '这个 Worker 没打开下单开关（wrangler secret put LIVE_TRADING 之后改成 true）');
        }
        const r = await armFetch(env, '/issue');
        return withCors(json({ armed: true, token: String(r?.token ?? '') }));
      }

      if (path === '/api/leverage' && req.method === 'POST') {
        await requireArm(env, req);
        const body = await readJson(req);
        const contract = String(body.contract ?? '');
        const leverage = numOf(body.leverage);
        const mode = body.mode === 'cross' ? 'cross' : 'isolated';
        if (!contract || !(leverage > 0)) throw new ApiError(400, 'BAD_INPUT', '合约和杠杆都要给');
        await c.setLeverage(contract, leverage, mode);
        return withCors(json({ ok: true, contract, leverage, mode }));
      }

      if (path === '/api/order' && req.method === 'POST') {
        await requireArm(env, req);
        const body = await readJson(req);
        const contract = String(body.contract ?? '');
        const size = numOf(body.size);
        const side: Direction = body.side === 'short' ? 'short' : 'long';
        const price = numOf(body.price);
        const tif = body.tif === 'ioc' ? 'ioc' : 'gtc';
        const stop = numOf(body.stop);
        const target = numOf(body.target);
        if (!contract || !(size > 0)) throw new ApiError(400, 'BAD_INPUT', '合约和张数都要给');
        if (price > 0 && tif === 'ioc') throw new ApiError(400, 'BAD_INPUT', '限价单不能用 ioc');

        const list = await c.contracts();
        const info = list.find((x) => x.name === contract);
        if (!info) throw new ApiError(400, 'NO_CONTRACT', '没有 ' + contract + ' 这个合约');
        validateOrderSize(size, info);
        const ref = price > 0 ? price : (info.markPrice || info.price);
        const notional = size * info.multiplier * ref;
        const cap = notionalCap(env);
        // 风控闸门：这一单的名义价值超过上限就不发。Worker 上没人盯着，这道闸是最后一道
        if (notional > cap) {
          throw new ApiError(400, 'NOTIONAL_CAP', '这一单名义 ' + notional.toFixed(2) + ' USDT，超过 Worker 的上限 ' + cap + ' USDT');
        }

        const input: OrderInput = { contract, size, side, price, tif };
        const order = await c.placeOrder(input);
        const bracket = stop > 0 || target > 0
          ? await attachAfterEntry(c, contract, side, stop, target)
          : null;
        return withCors(json({ ok: true, order, bracket, margin: null, checked: { notional } }));
      }

      const mCancel = /^\/api\/order\/([^/]+)$/.exec(path);
      if (mCancel && req.method === 'DELETE') {
        await requireArm(env, req);
        const id = decodeURIComponent(mCancel[1]!);
        await c.cancelOrder(id);
        return withCors(json({ ok: true, id }));
      }
      const mAmend = /^\/api\/order\/([^/]+)\/amend$/.exec(path);
      if (mAmend && req.method === 'POST') {
        await requireArm(env, req);
        const id = decodeURIComponent(mAmend[1]!);
        const body = await readJson(req);
        const price = numOf(body.price);
        const size = numOf(body.size);
        if (size > 0) {
          const existing = (await c.orders()).find((o) => o.id === id);
          const info = existing ? (await c.contracts()).find((x) => x.name === existing.contract) : undefined;
          if (!info) throw new ApiError(404, 'ORDER_NOT_FOUND', '找不到这张委托，可能已经成交或撤掉了');
          validateOrderSize(size, info);
        }
        await c.amendOrder(id, { price: price > 0 ? price : undefined, size: size > 0 ? size : undefined });
        return withCors(json({ ok: true, id }));
      }

      if (path === '/api/close-position' && req.method === 'POST') {
        await requireArm(env, req);
        const body = await readJson(req);
        const contract = String(body.contract ?? '');
        const dir: Direction = body.direction === 'short' ? 'short' : 'long';
        const sides = await c.positions();
        const mine = sides.find((p) => p.contract === contract && p.direction === dir);
        if (!mine || !(mine.size > 0)) throw new ApiError(404, 'NO_POSITION', '这个合约上没有' + (dir === 'long' ? '多' : '空') + '单持仓');

        const canceled: { orders: string[]; triggers: string[]; errors: string[] } = { orders: [], triggers: [], errors: [] };
        const protect = (await c.triggers().catch(() => [] as PriceOrder[])).filter(
          (t) => t.protective && t.contract === contract && (t.direction === dir || t.direction === ''),
        );
        for (const t of protect) {
          try { await c.cancelTrigger(t.id); canceled.triggers.push(t.id); } catch (e) { canceled.errors.push(String(e)); }
        }
        const r = await c.marketClose(contract, dir, mine.size);
        return withCors(json({ ok: true, orders: [{ direction: dir, size: mine.size, id: r.id, status: r.status }], canceled }));
      }

      if (path === '/api/bracket' && req.method === 'POST') {
        await requireArm(env, req);
        const body = await readJson(req);
        const contract = String(body.contract ?? '');
        const dir: Direction = body.direction === 'short' ? 'short' : 'long';
        const stop = numOf(body.stop);
        const target = numOf(body.target);
        const sides = await c.positions();
        const mine = sides.find((p) => p.contract === contract && p.direction === dir);
        if (!mine) throw new ApiError(404, 'NO_POSITION', '没有持仓就没法挂保护单');
        const r = await applyBracket(c, contract, dir, stop, target);
        if (r.created.length === 0 && r.errors.length > 0 && (stop > 0 || target > 0)) {
          throw new ApiError(400, 'BRACKET_FAILED', r.errors.join(' | '));
        }
        return withCors(json({ ...r, size: mine.size }));
      }

      if (path === '/api/reverse-position' && req.method === 'POST') {
        await requireArm(env, req);
        const body = await readJson(req);
        const contract = String(body.contract ?? '');
        const dir: Direction = body.direction === 'short' ? 'short' : 'long';
        const sides = await c.positions();
        const mine = sides.find((p) => p.contract === contract && p.direction === dir);
        if (!mine || !(mine.size > 0)) throw new ApiError(404, 'NO_POSITION', '没有持仓可反手');
        const canceled: { orders: string[]; triggers: string[]; errors: string[] } = { orders: [], triggers: [], errors: [] };
        for (const t of (await c.triggers().catch(() => [] as PriceOrder[])).filter((x) => x.protective && x.contract === contract)) {
          try { await c.cancelTrigger(t.id); canceled.triggers.push(t.id); } catch (e) { canceled.errors.push(String(e)); }
        }
        await c.marketClose(contract, dir, mine.size);
        const open = dir === 'long' ? 'short' : 'long';
        await c.placeOrder({ contract, size: mine.size, side: open, price: 0, tif: 'ioc' });
        return withCors(json({ ok: true, direction: open, size: mine.size, canceled }));
      }

      if (path === '/api/add-position' && req.method === 'POST') {
        await requireArm(env, req);
        const body = await readJson(req);
        const contract = String(body.contract ?? '');
        const dir: Direction = body.direction === 'short' ? 'short' : 'long';
        const size = numOf(body.size);
        const info = (await c.contracts()).find((x) => x.name === contract);
        if (!info) throw new ApiError(400, 'NO_CONTRACT', '没有 ' + contract + ' 这个合约');
        validateOrderSize(size, info);
        const order = await c.placeOrder({ contract, size, side: dir, price: 0, tif: 'ioc' });
        return withCors(json({ ok: true, order }));
      }

      // ---------- 这套连接没有的东西 ----------
      if (path === '/api/levels') {
        throw new ApiError(
          503, 'ENGINE_UNAVAILABLE',
          '这一套（Cloudflare Worker 直连交易所）没有关键位引擎：它要跑 Python，Worker 里跑不了。'
          + '要看支撑阻力，把设置页的服务器地址改回电脑上那个。',
        );
      }
      if (path === '/api/ip') {
        return withCors(json({ ok: true, ip: req.headers.get('cf-connecting-ip') ?? '', country: (req.cf as any)?.country ?? '', at: Date.now() }));
      }
      if (path === '/api/diag') {
        return withCors(json({ ok: true, worker: true, exchange: c.id, restBaseUrl: c.restBaseUrl }));
      }
      if (path === '/' ) {
        return withCors(new Response('巡风 Worker：这是给手机 App 用的接口，不是网页。', { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
      }
      throw new ApiError(501, 'NOT_ON_WORKER', '这个功能只在电脑上的服务端里有（Worker 这套连接只有行情和交易）');
    } catch (e) {
      return withCors(toResponse(e));
    }
  },
};
