import { Router, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { config, envLabel } from './config.js';
import { GateError } from './exchange/errors.js';
import { exchange } from './exchange/index.js';
import type { XContract, XPosition, XOrder, XTrigger, XOrderSpec } from './exchange/types.js';
import { isSizeOnStep } from './exchange/size.js';
import {
  bodyOf, flag, numberOr, oneOf, oneOfOr, optionalNumber, requiredNumber, requiredText,
} from './http/params.js';
import type { Account, OpenOrder, Position, PriceOrder, PrivateState } from '@xfrine/contract';
import { instrumentOf } from './exchange/instrument.js';

/**
 * 交易这一侧只有两边。
 *
 * 以前这里借的是关键位模块的 Direction，它多一个 'both' —— 那是「两边都算」的
 * 分析语义，跟下单无关。借用它会让「这个方向上有仓吗」这类判断看上去可以传 'both'，
 * 而代码里其实永远不会，编译器也就不再帮我们排除它。
 */
type Direction = 'long' | 'short';

interface TradeRouteDeps {
  wrap: (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => void;
  requireArm: (req: Request) => void;
  requireLocal: (req: Request, what: string) => void;
  armValid: (req: Request) => boolean;
  translate: (error: unknown) => unknown;
  armTokens: Set<string>;
  tradeContract(name: string): Promise<XContract>;
}

export function mountTradeRoutes(router: Router, deps: TradeRouteDeps) {
  const { wrap, requireArm, requireLocal, armTokens, armValid, translate, tradeContract } = deps;
  type GateContract = XContract;
  const dailyPnlCacheTtlMs = 3_000;
  let dailyPnlCache: {
    key: string;
    at: number;
    value: number | null;
    error: unknown;
    pending: Promise<number> | null;
  } | null = null;

  async function cachedDailyRealisedPnl(fromMs: number): Promise<number> {
    const accountScope = createHash('sha256').update(config.key).digest('hex');
    const key = `${exchange().id}:${config.env}:${accountScope}:${fromMs}`;
    const now = Date.now();
    if (dailyPnlCache?.key === key) {
      if (dailyPnlCache.pending) return dailyPnlCache.pending;
      if (now - dailyPnlCache.at < dailyPnlCacheTtlMs) {
        if (dailyPnlCache.error) throw dailyPnlCache.error;
        if (dailyPnlCache.value !== null) return dailyPnlCache.value;
      }
    }

    const entry = {
      key,
      at: 0,
      value: null as number | null,
      error: null as unknown,
      pending: null as Promise<number> | null,
    };
    const pending = exchange().dailyRealisedPnl(fromMs, Date.now());
    entry.pending = pending;
    dailyPnlCache = entry;
    try {
      entry.value = await pending;
      entry.at = Date.now();
      return entry.value;
    } catch (error) {
      entry.error = error;
      entry.at = Date.now();
      throw error;
    } finally {
      entry.pending = null;
    }
  }

  function localDayStart(req: Request): number {
    const raw = Array.isArray(req.query.dayStart) ? req.query.dayStart[0] : req.query.dayStart;
    const requested = Number(raw);
    const now = Date.now();
    if (Number.isFinite(requested) && requested <= now && requested >= now - 36 * 60 * 60_000) {
      return requested;
    }
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }

  const notionalOf = (sizeContracts: number, price: number, multiplier: number): number =>
    Math.abs(sizeContracts) * multiplier * price;
  // ---------- 账户与持仓 ----------

  type GatePosition = XPosition;

  /** 按契约的 Account 写：字段对不上时 tsc 在这里报，别等页面读到 undefined */
  async function readAccount(): Promise<Account> {
    const a = await exchange().account();
    return {
      total: a.total,
      available: a.available,
      unrealisedPnl: a.unrealised_pnl,
      currency: a.currency,
    };
  }

  router.get('/account', wrap(async (_req, res) => {
    res.json(await readAccount());
  }));

  /**
   * 读取指定合约的持仓。
   * 单仓模式下 GET /positions/{contract} 返回一个对象（mode='single'）；
   * 双向模式下返回两条 [dual_long, dual_short]。这里统一成「多方向量」。
   */
  interface Side {
    direction: Direction;
    size: number;          // 正数，0 表示这一边没有仓
    entryPrice: number;
    markPrice: number;
    liqPrice: number;
    unrealisedPnl: number;
    leverage: number;
    value: number;
  }

  /**
   * 持仓方向。双向模式的 mode 直接写 dual_long / dual_short。
   * 单向模式只有一个仓，方向藏在 size 的符号里（负数是空头）。
   * 只看 mode 会把单向模式的空单当成多单，反手和加仓就会找错边。
   */
  function sideOf(mode: string, size: number): Direction {
    return mode.includes('short') || (!mode.includes('dual') && size < 0) ? 'short' : 'long';
  }

  async function readSides(contract: string): Promise<Side[]> {
    const raw = await exchange().positions(contract);
    const rows = Array.isArray(raw) ? raw : [raw];
    const out: Side[] = [];
    for (const p of rows) {
      if (!p) continue;
      const size = Number(p.size ?? 0);
      if (size === 0) continue;
      out.push({
        direction: sideOf(String(p.mode ?? ''), size),
        size: Math.abs(size),
        entryPrice: Number(p.entry_price ?? 0),
        markPrice: Number(p.mark_price ?? 0),
        liqPrice: Number(p.liq_price ?? 0),
        unrealisedPnl: Number(p.unrealised_pnl ?? 0),
        leverage: Number(p.leverage ?? 0),
        value: Number(p.value ?? 0),
      });
    }
    return out;
  }

  /**
   * 当前所有持仓。
   *
   * 每一条都带上合约乘数：页面要按「(标记价 - 开仓价) × 张数 × 乘数，空头取负」自己现算已盈亏。
   * 只靠每次轮询带回来的那个数，价一动它就已经旧了，而且多空两边看不到同一个口径。
   * 这个式子和交易所的 unrealised_pnl 完全一致（模拟盘上多空各 1 张实测过），所以两边不会打架。
   */
  async function readPositions(): Promise<Position[]> {
    const list = await exchange().positions();
    /**
     * 按张数过滤，必须转成数字再比。
     *
     * 交易所把 size 写成字符串（"0"），拿它和数字 0 比永远不相等 —— 于是全仓平掉之后
     * 交易所仍保留的那条零张记录会被当成持仓返回，界面上是「0 张 / 开仓 0.0000 /
     * 盈亏 0.00 / 强平价 —」，还会让图上以为这一边有仓。
     */
    return list.filter((p) => Number.isFinite(Number(p.size)) && Number(p.size) !== 0).map((p) => {
      const size = Math.abs(Number(p.size) || 0);
      const mark = Number(p.mark_price) || 0;
      const value = Math.abs(Number(p.value) || 0);
      // 交易所就是这么算持仓价值的：价值 = 张数 × 乘数 × 标记价。
      // 反推乘数比去拉一张上千合约的全表快得多，两者的数完全一致。
      const multiplier = size > 0 && mark > 0 && value > 0 ? Number((value / (size * mark)).toPrecision(6)) : 0;
      return {
        contract: p.contract,
        instrument: instrumentOf(p.contract),
        size,
        direction: sideOf(String(p.mode ?? ''), Number(p.size)),
        leverage: Number(p.leverage),
        marginMode: String(p.margin_mode ?? '').toLowerCase() === 'crossed' ? 'cross'
          : String(p.margin_mode ?? '').toLowerCase() === 'isolated' ? 'isolated'
            : Number(p.leverage) > 0 ? 'isolated' : 'cross',
        entryPrice: Number(p.entry_price),
        markPrice: mark,
        liqPrice: Number(p.liq_price),
        unrealisedPnl: Number(p.unrealised_pnl),
        value,
        mode: p.mode,
        multiplier,
      };
    });
  }

  router.get('/positions', wrap(async (_req, res) => {
    res.json(await readPositions());
  }));

  /**
   * 下单时间统一成「秒」。
   * Gate 的 create_time 是带微秒小数的秒（1730000000.123456），
   * 页面那边直接乘 1000 转 Date；单位搞错会让委托列表上的时间变成 1970 年。
   * 这里再兜一层毫秒/微秒的历史格式，免得换个端点就显示成乱码时间。
   */
  function unixSeconds(v: unknown): number {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n > 1e14) return n / 1e6; // 微秒
    if (n > 1e11) return n / 1e3; // 毫秒
    return n;
  }

  async function readOpenOrders(contract?: string): Promise<OpenOrder[]> {
    const list = await exchange().openOrders(contract);
    return list.map((o): OpenOrder => ({
      id: String(o.id),
      contract: String(o.contract),
      instrument: instrumentOf(String(o.contract)),
      size: Number(o.size),
      left: Number(o.left),
      price: Number(o.price),
      fillPrice: Number(o.fill_price),
      status: String(o.status),
      finishAs: o.finish_as ? String(o.finish_as) : null,
      reduceOnly: Boolean(o.is_reduce_only),
      createTime: unixSeconds(o.create_time),
      tif: String(o.tif),
    }));
  }

  router.get('/orders', wrap(async (req, res) => {
    const contract = req.query.contract ? String(req.query.contract) : undefined;
    res.json(await readOpenOrders(contract));
  }));

  /**
   * 一张触发单。字段就是契约里的 PriceOrder —— 再抄一份的话，
   * 契约加一个字段，这边会静默漏掉（页面读到的就是 undefined）。
   */
  interface Trigger extends PriceOrder {
    cancelId: string;
    /** auto_size 直接写明平哪一边。空字符串表示认不出来（交易所网页上挂的、老的 isclose 单） */
    direction: Direction | '';
    /**
     * 是不是「到价平仓」的保护单。
     * 不能看 reduce_only：Gate 把 auto_size 单回读成 reduce_only: false，
     * 靠它判断会全部落空（实测：自己挂的止损读回来就是 false）。
     * 只有带 auto_size 或 isclose 的才会去平仓；别的触发单是「到价开仓」的条件单，不归保护管。
     */
    protective: boolean;
    /** 原样带回来的 reduce_only，只用来显示 */
    reduceOnly: boolean;
    /** 整边平仓（isclose）。只有这种认不出方向的单才可能需要按合约清掉 */
    closeAll: boolean;
    triggerPrice: number;
    triggerRule: number;
    size: number;
    /** 挂单时间，unix 秒 */
    createTime: number;
    /**
     * 什么时候会被交易所自己撤掉，unix 秒；0 表示不带过期（或读不出来）。
     * 这一项以前完全没读 —— 于是 24 小时一到保护单悄悄消失，
     * 页面上只显示「止损未设」，没人知道是被过期撤掉的。现在把它带到页面上。
     */
    expiresAt: number;
  }

  /**
   * 保护单的有效期（秒）。
   *
   * Gate 的定义（gateapi-python / gateapi-go 的 FuturesPriceTrigger 文档原文）：
   * 「Maximum wait time for trigger condition (in seconds). Order will be cancelled if timeout」
   * —— 到点交易所自己把止损止盈撤掉，仓就没有保护了。0 的含义文档没写，
   * 不拿真钱去试，所以维持 24 小时；但 expiresAt 会跟着接口回到页面上，
   * 剩多久、什么时候没的，用户必须看得见（见 readTriggers 和页面上的保护提示）。
   */
  const PROTECT_EXPIRATION_SEC = 86_400;

  async function readTriggers(contract?: string): Promise<Trigger[]> {
    const list = await exchange().triggers();
    return list.map((o) => {
      const initial = o.initial as unknown as Record<string, unknown>;
      const trigger = o.trigger as unknown as Record<string, unknown>;
      const auto = String(initial.auto_size ?? '');
      const closeAll = Boolean(initial.isclose);
      const expiration = Number(trigger.expiration ?? 0);
      const createTime = unixSeconds(o.create_time);
      return {
        id: String(o.id),
        cancelId: String(o.cancel_id ?? o.id),
        contract: String(initial.contract ?? ''),
        instrument: instrumentOf(String(initial.contract ?? '')),
        direction: auto.includes('long') ? 'long' : auto.includes('short') ? 'short' : '',
        protective: closeAll || auto !== '',
        reduceOnly: Boolean(initial.reduce_only),
        closeAll,
        triggerPrice: Number(trigger.price ?? 0),
        triggerRule: Number(trigger.rule ?? 0),
        size: Number(initial.size ?? 0),
        createTime,
        // 交易所到点会自己撤掉，所以到期时刻 = 挂单时间 + 有效期。传 0 才表示没有这一层
        expiresAt: expiration > 0 && createTime > 0 ? createTime + expiration : 0,
      } as Trigger;
    }).filter((t) => !contract || t.contract === contract);
  }

  router.get('/price-orders', wrap(async (_req, res) => {
    res.json(await readTriggers());
  }));

  /**
   * 账户、持仓、委托、触发单一次取全。
   *
   * 页面每 3 秒刷一次这些私有数据。分开取要发四个请求，而且四个响应来自四个时刻 ——
   * 持仓和它的止损单可能一个新一个旧，看上去就像「止损没挂上」。
   * 合成一个接口顺带把一次刷新的延迟压到一个往返里。
   */
  router.get('/private-state', wrap(async (req, res) => {
    // 余额、持仓、委托和保护单不是同一项权限。某一类权限不足时仍返回其余可读数据，
    // 尤其不能因「持仓读取」失败，就把成功取到的可用余额一起丢掉。
    const [accountResult, positionsResult, ordersResult, priceOrdersResult] = await Promise.allSettled([
      readAccount(),
      readPositions(),
      readOpenOrders(),
      readTriggers(),
    ]);
    const errors = {
      ...(accountResult.status === 'rejected' ? { account: errText(accountResult.reason) } : {}),
      ...(positionsResult.status === 'rejected' ? { positions: errText(positionsResult.reason) } : {}),
      ...(ordersResult.status === 'rejected' ? { orders: errText(ordersResult.reason) } : {}),
      ...(priceOrdersResult.status === 'rejected' ? { priceOrders: errText(priceOrdersResult.reason) } : {}),
    };
    // armed 让页面每 3 秒对一次账：令牌没了就把「已解锁」收掉，而不是等下一次下单被拒
    const body: PrivateState = {
      ...(accountResult.status === 'fulfilled' ? { account: accountResult.value } : {}),
      ...(positionsResult.status === 'fulfilled' ? { positions: positionsResult.value } : {}),
      ...(ordersResult.status === 'fulfilled' ? { orders: ordersResult.value } : {}),
      ...(priceOrdersResult.status === 'fulfilled' ? { priceOrders: priceOrdersResult.value } : {}),
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
      armed: armValid(req),
    };
    res.json(body);
  }));

  router.get('/daily-pnl', wrap(async (req, res) => {
    const fromMs = localDayStart(req);
    const toMs = Date.now();
    const realisedPnl = await cachedDailyRealisedPnl(fromMs);
    res.json({ realisedPnl, fromMs, toMs, currency: 'USDT' });
  }));

  // ---------- 平仓、反手之前要清掉的东西 ----------

  interface Cleanup {
    /** 撤掉的未成交委托号 */
    orders: string[];
    /** 撤掉的触发单号 */
    triggers: string[];
    errors: string[];
  }

  const errText = (e: unknown): string => {
    const readable = translate(e);
    return readable instanceof GateError ? `${readable.label} ${readable.detail}` : String(readable);
  };

  /**
   * 这张委托会不会动到 dir 这一边。
   * 买 + 减仓 = 平多；卖 + 非减仓 = 开空/加空。其余组合都不是这一边的事。
   */
  function touchesSide(size: number, reduceOnly: boolean, dir: Direction): boolean {
    const buy = size > 0;
    if (reduceOnly) return dir === 'long' ? !buy : buy;
    return dir === 'long' ? buy : !buy;
  }

  /**
   * 把 dir 这一边名下的挂单和触发单撤掉。平仓、反手、开新仓之前都叫它。
   *
   * 非撤不可的原因：
   *   - 触发单是给这个仓位挂的。仓没了它们还留着，下次开同方向的仓，一出现就被这些单打掉，
   *     而且它们永远不会撤，页面上会一直挂着一堆找不到主人的「止损」。
   *   - reduce_only 的限价单同理，仓没了就没有意义；不带 reduce_only 的限价单留着，
   *     会在平完仓之后重新开出一个仓来 —— 你以为已经空仓，实际多了一个没人管的仓。
   *
   * 双向模式下另一边可能还有仓，那时候只动这一边的单：那边还挂着自己的保护单和减仓单。
   * 另一边也空着说明这个合约要清干净了，那就一张不留 —— 单向模式下反向的限价单成交后同样会开仓。
   */
  async function cancelSide(contract: string, dirs: Direction[], contractFlat: boolean): Promise<Cleanup> {
    const out: Cleanup = { orders: [], triggers: [], errors: [] };
    // 合约是不是真的空仓了，由调用方按「平仓实际成交了多少」判断，不再靠方向个数猜：
    // 想平两边但只成交了一边时，dirs 会有两个，可另一边其实还裸着。
    const flatAfter = contractFlat;

    let triggers: Trigger[] = [];
    try {
      triggers = await readTriggers(contract);
    } catch (e) {
      out.errors.push(`读触发单失败: ${errText(e)}`);
    }
    const canceledIds = new Set<string>();
    for (const t of triggers) {
      // 认不出平哪一边的整边平仓单（isclose），只有在这个合约要清干净时才敢动
      const mine = t.direction ? dirs.includes(t.direction) : t.closeAll && flatAfter;
      if (!mine) continue;
      if (canceledIds.has(t.cancelId)) continue;
      canceledIds.add(t.cancelId);
      try {
        await exchange().cancelTrigger(t.cancelId);
        out.triggers.push(t.cancelId);
      } catch (e) {
        out.errors.push(`撤触发单 ${t.id}: ${errText(e)}`);
      }
    }

    let open: XOrder[] = [];
    try {
      open = await exchange().openOrders(contract);
    } catch (e) {
      out.errors.push(`读挂单失败: ${errText(e)}`);
    }
    for (const o of open) {
      const id = String(o.id);
      const size = Number(o.size);
      const reduceOnly = Boolean(o.is_reduce_only);
      const mine = flatAfter || dirs.some((d) => touchesSide(size, reduceOnly, d));
      if (!mine) continue;
      try {
        await exchange().cancelOrder(id);
        out.orders.push(id);
      } catch (e) {
        out.errors.push(`撤委托 ${id}: ${errText(e)}`);
      }
    }
    return out;
  }

  /**
   * 开新仓之前，把这一边没人管的触发单清掉。
   * 上一个仓早就没了，留着这些单只会让新仓一出现就被打掉；有仓的时候不动，
   * 那时候的触发单是有主的，覆盖语义归 /api/bracket 管。
   */
  async function clearOrphanTriggers(contract: string, dir: Direction): Promise<string[]> {
    // 查询失败时不能把「不知道有没有仓」当成空仓，否则可能撤掉现有仓位的保护单。
    const sides = await readSides(contract);
    if (sides.some((s) => s.direction === dir && s.size > 0)) return [];
    const out: string[] = [];
    const canceledIds = new Set<string>();
    for (const t of (await readTriggers(contract)).filter((x) => x.protective && x.direction === dir)) {
      if (canceledIds.has(t.cancelId)) continue;
      canceledIds.add(t.cancelId);
      await exchange().cancelTrigger(t.cancelId);
      out.push(t.cancelId);
    }
    return out;
  }

  // ---------- 交易 ----------

  router.post('/trade/arm', wrap(async (req, res) => {
    // 只有明确说「关」才落锁；不传或者传 true 都是解锁
    const body = bodyOf(req.body);
    if (body.on !== undefined && !flag(body.on)) {
      armTokens.clear();
      res.json({ armed: false });
      return;
    }
    if (!config.liveTrading) throw new GateError(403, 'LIVE_DISABLED', `服务端 LIVE_TRADING=false，先在设置里打开${envLabel()}下单开关`);
    exchange().requireKeys();
    const token = randomUUID();
    armTokens.add(token);
    res.json({ armed: true, token });
  }));

  /**
   * 设杠杆，顺手设保证金模式。
   *
   * Gate 没有单独的「逐仓/全仓」开关：leverage 传非 0 就是逐仓，传 0 就是全仓，
   * 全仓的杠杆放在 cross_leverage_limit 里。所以模式只能从这里设 ——
   * 页面以前只传 leverage，账户又是全仓开的，于是「你以为在逐仓，其实在拿整个余额兜底」。
   * 返回里带上交易所真正接受的那一套，页面照着显示，不自己猜。
   */
  router.post('/leverage', wrap(async (req, res) => {
    requireArm(req);
    const body = bodyOf(req.body);
    const contract = requiredText(body.contract, 'contract', { max: 64 });
    const lev = Math.round(requiredNumber(body.leverage, 'leverage', { positive: true }));
    // 不传按逐仓（账户默认是全仓，不说一声就等于拿整个余额兜底）
    const cross = oneOfOr(body.mode, 'mode', ['cross', 'isolated'] as const, 'isolated') === 'cross';
    const c = await tradeContract(contract);
    if (lev < Number(c.leverage_min) || lev > Number(c.leverage_max)) {
      throw new GateError(400, 'LEVERAGE_RANGE', `该合约杠杆范围 ${c.leverage_min} - ${c.leverage_max}`);
    }
    // 各家的写法差得远（Gate 靠 leverage=0 表示全仓，Bitget 是单独的保证金模式接口），
    // 这一层翻译在适配器里
    const r = await exchange().setLeverage(contract, { lev, cross });
    res.json({
      ok: true,
      mode: r.mode,
      leverage: r.leverage,
      crossLeverageLimit: r.crossLeverageLimit,
    });
  }));

  interface PlaceSpec {
    contract: string;
    side: Direction;
    /** 正数张数。整边平仓（autoSize）时传 0。 */
    size: number;
    /** 0 或不传 = 市价 */
    price?: number;
    tif?: 'gtc' | 'ioc' | 'poc' | 'fok';
    reduceOnly?: boolean;
    /** 平掉整边：close_long / close_short */
    autoSize?: 'close_long' | 'close_short';
  }

  interface PreparedOrder {
    info: GateContract;
    /** 统一的下单参数（张数为正负、price 为 '0' 表示市价），由适配器翻成各家写法 */
    payload: XOrderSpec;
    price: number;
    isMarket: boolean;
    notional: number;
  }

  /**
   * 只校验、只拼参数，不发单。
   * 改单必须先拿新参数验一遍再撤旧单 —— 否则新价超出允许偏离时，
   * 校验会失败，而旧单已经被撤掉了，手上什么都没挂。
   */
  async function prepareOrder(spec: PlaceSpec): Promise<PreparedOrder> {
    const contract = String(spec.contract);
    // 参数取自下单环境：价格位数、杠杆范围、偏离上限都按那台交易所的规则，不是主网行情的
    const c = await tradeContract(contract);

    if (spec.autoSize) {
      if (Number(spec.size) !== 0) throw new GateError(400, 'BAD_INPUT', '整边平仓不能指定张数');
      return {
        info: c,
        payload: {
          contract, size: 0, price: '0', tif: 'ioc',
          reduce_only: true, close: false, auto_size: spec.autoSize,
        },
        price: Number(c.last_price),
        isMarket: true,
        notional: 0,
      };
    }

    const requestedSize = Math.abs(Number(spec.size));
    if (!Number.isFinite(requestedSize) || requestedSize === 0) throw new GateError(400, 'BAD_INPUT', '张数不合法');
    const sizeStep = Number(c.size_step) > 0 ? Number(c.size_step) : 1;
    const minSize = Number(c.order_size_min) > 0 ? Number(c.order_size_min) : sizeStep;
    const maxSize = Number(c.order_size_max ?? 0);
    if (requestedSize < minSize) throw new GateError(400, 'SIZE_MIN', `最小下单 ${minSize} 张`);
    if (maxSize > 0 && requestedSize > maxSize) throw new GateError(400, 'SIZE_MAX', `最大下单 ${maxSize} 张`);
    if (!isSizeOnStep(requestedSize, sizeStep)) {
      throw new GateError(400, 'SIZE_STEP', `张数必须按 ${sizeStep} 张递增`);
    }
    const sizeRaw = Number((Math.round(requestedSize / sizeStep) * sizeStep).toFixed(12));

    let price = Number(spec.price ?? 0);
    const isMarket = !Number.isFinite(price) || price <= 0;
    if (isMarket) price = Number(c.last_price);

    // 名义价值只做回执，不限制大小
    const notional = notionalOf(sizeRaw, price, Number(c.quanto_multiplier));

    // 价格偏离保护：限价单价格不能离现价太远，防手滑
    if (!isMarket) {
      const last = Number(c.last_price);
      const deviate = Math.abs(price - last) / last;
      const cap = Math.max(0.05, Number(c.order_price_deviate) || 0.05);
      if (deviate > cap) {
        throw new GateError(400, 'PRICE_DEVIATE', `限价 ${price} 偏离现价 ${(deviate * 100).toFixed(2)}%，超过该合约允许的 ${(cap * 100).toFixed(1)}%`);
      }
      const round = Number(c.order_price_round);
      if (round > 0 && Math.abs(price / round - Math.round(price / round)) > 1e-6) {
        throw new GateError(400, 'PRICE_ROUND', `价格必须是 ${round} 的整数倍`);
      }
      // 吸附到最小变动单位，避免浮点尾巴（73630.40000000001）被交易所拒掉
      price = Number((Math.round(price / round) * round).toFixed(10));
    }

    const signedSize = spec.side === 'long' ? Math.abs(sizeRaw) : -Math.abs(sizeRaw);
    return {
      info: c,
      payload: {
        contract,
        size: signedSize,
        price: isMarket ? '0' : String(price),
        tif: spec.tif ?? (isMarket ? 'ioc' : 'gtc'),
        reduce_only: Boolean(spec.reduceOnly),
      },
      price,
      isMarket,
      notional,
    };
  }

  /**
   * Gate 拒单时只回一句英文，例如：
   *   margin 6180.18970275 while available 974.218011424088
   * 把两个数取出来，按同样的杠杆算出可用余额够做多少张，再换成中文。
   * 保证金是交易所算的，这里不改判定，只把账说出来。
   */
  function explainMargin(e: unknown, prepared: PreparedOrder): unknown {
    if (!(e instanceof GateError)) return e;
    const m = /margin\s+([\d.]+)\s+while\s+available\s+([\d.]+)/i.exec(e.detail);
    if (!m) return e;
    const need = Number(m[1]);
    const avail = Number(m[2]);
    const qty = Math.abs(Number(prepared.payload.size));
    if (!(need > 0) || !(avail >= 0) || !(qty > 0)) return e;
    const enough = Math.floor((qty * avail) / need);
    const price = prepared.price;
    return new GateError(
      400,
      'MARGIN_NOT_ENOUGH',
      `${prepared.payload.contract} ${qty} 张 @${price} 要 ${need.toFixed(2)} USDT 保证金，`
      + `账户只有 ${avail.toFixed(2)} USDT，差 ${(need - avail).toFixed(2)}。`
      + `按同样的杠杆，可用余额最多做 ${enough} 张。降张数、提高杠杆，或者先平掉别的仓位。`,
    );
  }

  /**
   * 开仓前把保证金模式设成用户选的那个。
   *
   * 为什么要在服务端做：页面以前是「先设杠杆、再下单」，那一步失败只弹一句提示就继续发单。
   * 结果是在一个你以为不是的模式里开的仓 —— 逐仓的止损意义完全建立在「亏损不会越过这一笔保证金」上，
   * 模式错了，止损就只是心理安慰。所以这里改成「设不成就不发单」。
   *
   * 这一边已经有持仓时不去动它：交易所本来也不让在有仓的时候改模式，
   * 硬试只会让加仓失败一场。返回里写明没动，页面照着说。
   */
  async function ensureMarginMode(
    contract: string, side: Direction, lev: number, mode: 'isolated' | 'cross',
  ) {
    // 只要这个合约上还有仓（哪一边都算），交易所就不让改模式 —— 硬试只会让加仓失败一场。
    // 所以跳过并把现状说出去，页面照着提示：这一单是照着交易所现有的模式开的。
    // 持仓查询失败时不能假定为空仓并改杠杆，必须停止后续开仓。
    const sides = await readSides(contract);
    if (sides.some((s) => s.size > 0)) {
      return { applied: false as const, mode, why: '这个合约上还有持仓，模式沿用交易所现状' };
    }
    const cross = mode === 'cross';
    try {
      await exchange().setLeverage(contract, { lev, cross });
      return { applied: true as const, mode, leverage: lev };
    } catch (e) {
      const detail = e instanceof GateError ? `${e.label} ${e.detail}` : String(e);
      throw new GateError(
        400,
        'MARGIN_MODE',
        `保证金模式没能设成${cross ? '全仓' : '逐仓'}：${detail}。这一单没有发出去 —— `
        + '模式没切过来就开仓，止损护住的范围和你想的不是一回事。',
      );
    }
  }

  async function placeOrder(spec: PlaceSpec): Promise<{ prepared: PreparedOrder; order: XOrder }> {
    const prepared = await prepareOrder(spec);
    try {
      const order = await exchange().placeOrder(prepared.payload);
      return { prepared, order };
    } catch (e) {
      throw explainMargin(e, prepared);
    }
  }

  const orderReceipt = (order: XOrder) => ({
    id: String(order.id),
    contract: String(order.contract),
    size: Number(order.size),
    price: Number(order.price),
    status: String(order.status),
    fillPrice: Number(order.fill_price ?? 0),
  });

  router.post('/order', wrap(async (req, res) => {
    requireArm(req);
    /**
     * 先把外部输入变成确定的类型，再往下走。
     *
     * 以前是 `Number(body.size)` 直接交给 placeOrder：字段漏传时是 NaN，
     * 一路飘到「张数不够最小」之类的下游判断，报出来的话跟真正的原因对不上。
     */
    const body = bodyOf(req.body);
    const contract = requiredText(body.contract, 'contract', { max: 64 });
    const side = oneOfOr(body.side, 'side', ['long', 'short'] as const, 'long');
    const size = requiredNumber(body.size, 'size', { positive: true });
    const price = numberOr(body.price, 'price', 0, { min: 0 });
    const stop = numberOr(body.stop, 'stop', 0, { min: 0 });
    const target = numberOr(body.target, 'target', 0, { min: 0 });
    const reduceOnly = flag(body.reduceOnly);
    const tif = body.tif === undefined || body.tif === null || body.tif === ''
      ? undefined
      : oneOf(body.tif, 'tif', ['gtc', 'ioc', 'poc', 'fok'] as const);
    // 开仓前先清掉这一边没人管的触发单（上一个仓已经没了的那种）。
    // 清不掉不影响下单，顶多在回执里少报一项。
    const cleared = reduceOnly ? [] : await clearOrphanTriggers(contract, side).catch(() => [] as string[]);
    // 开仓前把保证金模式定下来。平仓（reduceOnly）不动它：平仓和模式无关，白跑一趟还可能被交易所拒。
    const marginMode = oneOfOr(body.marginMode, 'marginMode', ['isolated', 'cross'] as const, 'isolated');
    const openLev = Math.round(numberOr(body.leverage, 'leverage', 10, { positive: true })) || 10;
    const margin = reduceOnly ? null : await ensureMarginMode(contract, side, openLev, marginMode);
    const { prepared, order } = await placeOrder({
      contract,
      side,
      size,
      price,
      tif,
      reduceOnly,
    });
    // 开仓顺手挂保护。两个价都空着就是纯开仓，不碰现有的触发单。
    const bracket = (stop > 0 || target > 0) && !reduceOnly
      ? await attachAfterEntry(contract, side, stop, target)
      : null;
    res.json({
      ok: true,
      order: orderReceipt(order),
      bracket,
      /** 保证金模式设没设上。没设上时这里会写 why，页面要照说 */
      margin,
      /** 开仓前顺手清掉的孤儿触发单 */
      cleared,
      checked: {
        notional: Math.round(prepared.notional * 100) / 100,
        multiplier: Number(prepared.info.quanto_multiplier),
        price: prepared.price,
      },
    });
  }));

  router.delete('/order/:id', wrap(async (req, res) => {
    requireArm(req);
    await exchange().cancelOrder(String(req.params.id));
    res.json({ ok: true });
  }));

  /**
   * 改单：先校验、再撤旧单、按新条件重挂。
   * 先验后撤，是为了让合法的旧单不因为新参数不合法而平白消失。
   *   1. 把新价新量按下单同一套规则验一遍。验不过就直接报错，旧单还在。
   *   2. 验过了才撤，撤完重挂。挂不上时明确说「旧单已撤」，不留悬念。
   * 张数按剩余量算：已成交的部分不重挂，否则 10 张的委托改个价会变成 12 张。
   */
  router.post('/order/:id/amend', wrap(async (req, res) => {
    requireArm(req);
    const id = String(req.params.id);
    const body = bodyOf(req.body);
    const o = await exchange().order(id);
    if (!o || !o.id) throw new GateError(404, 'ORDER_NOT_FOUND', '找不到这张委托，可能已经成交或撤掉了');
    if (String(o.status ?? '') !== 'open') {
      throw new GateError(400, 'ORDER_NOT_OPEN', '这张委托已经不在挂着（成交或已撤），改不了了');
    }

    const contract = String(o.contract ?? '');
    const origSize = Number(o.size ?? 0);
    const left = Math.abs(Number(o.left ?? origSize));
    const side: Direction = origSize > 0 ? 'long' : 'short';

    // 没填张数就按剩余量改价；填了就必须是正数
    const sizeIn = optionalNumber(body.size, 'size', { positive: true });
    const rawSize = sizeIn === undefined ? left : Math.abs(sizeIn);
    if (rawSize > left) {
      throw new GateError(400, 'AMEND_SIZE_MAX', `这张单只剩 ${left} 张没成交，改单只能改到 ${left} 张以内。想加大请重新下单`);
    }

    const priceIn = optionalNumber(body.price, 'price', { positive: true });
    const rawPrice = priceIn === undefined ? Number(o.price ?? 0) : priceIn;
    if (!(rawPrice > 0)) throw new GateError(400, 'AMEND_PRICE', '市价单没有价格可改，只能撤掉重下');

    const tif = String(o.tif ?? 'gtc');
    const prepared = await prepareOrder({
      contract,
      side,
      size: rawSize,
      price: rawPrice,
      tif: tif === 'ioc' || tif === 'poc' || tif === 'fok' ? tif : 'gtc',
      reduceOnly: Boolean(o.is_reduce_only),
    });

    // 到这一步新单已经确定挂得出去，才动旧单
    await exchange().cancelOrder(id);
    try {
      const order = await exchange().placeOrder(prepared.payload);
      res.json({
        ok: true,
        replaced: { oldId: id, ...orderReceipt(order) },
        checked: { price: prepared.price, notional: Math.round(prepared.notional * 100) / 100 },
      });
    } catch (e) {
      const explained = explainMargin(e, prepared);
      const msg = explained instanceof GateError ? `${explained.label} ${explained.detail}` : String(explained);
      throw new GateError(500, 'AMEND_PARTIAL', `旧单已撤，新单没挂上：${msg}。请重新下一单`);
    }
  }));

  /**
   * 市价平掉这几边，再把这些边名下的委托和触发单撤掉。
   *
   * 顺序是「先平、后撤」：反过来的话，平仓万一被交易所拒了，保护单已经没了，仓就裸着。
   * 先平的风险只在平仓到撤单之间那几毫秒 —— 挂着的委托顶多在这几毫秒里成交。
   */
  async function flattenSides(contract: string, wanted: Side[], all: Side[]) {
    const orders: { direction: Direction; size: number; id: string; status: string }[] = [];
    /** 真的平干净了的那几边。没平完的那一边不能撤保护，否则仓还开着却没人管 */
    const closed: Direction[] = [];
    const notFullyClosed: string[] = [];
    for (const s of wanted) {
      const { order } = await placeOrder({
        contract,
        side: s.direction,
        size: 0,
        autoSize: s.direction === 'long' ? 'close_long' : 'close_short',
      });
      const status = String(order.status ?? '');
      const left = Number(order.left ?? 0);
      const done = String(order.finish_as ?? '') === 'filled' || (status === 'finished' && left === 0);
      orders.push({ direction: s.direction, size: s.size, id: String(order.id), status });
      if (done) {
        closed.push(s.direction);
      } else {
        // 盘口太薄时市价平仓只成交一部分。这一边还有仓，保护单必须留着。
        notFullyClosed.push(
          `平${s.direction === 'long' ? '多' : '空'}没完全成交（剩 ${left} 张，状态 ${status || '未知'}），这一边的保护单没有撤`,
        );
      }
    }
    const otherSideHasPosition = all.some((s) => s.size > 0 && !wanted.includes(s));
    const flat = !otherSideHasPosition && closed.length === wanted.length;
    const canceled = await cancelSide(contract, closed, flat);
    canceled.errors.push(...notFullyClosed);
    return { orders, canceled };
  }

  /**
   * 市价平仓。
   * 不能用 close:true —— 双向持仓模式下 Gate 直接拒绝（POSITION_DUAL_MODE）。
   * auto_size 两种模式都能用：它按方向把整边平掉，单仓模式下也一样。
   *
   * 平仓会连带撤掉这一边的挂单和触发单，回执里列出撤掉了哪些。
   */
  router.post('/close-position', wrap(async (req, res) => {
    requireArm(req);
    const body = bodyOf(req.body);
    const contract = requiredText(body.contract, 'contract', { max: 64 });
    // 不指明方向就平掉这一边全部
    const direction = body.direction === undefined || body.direction === null || body.direction === ''
      ? undefined
      : oneOf(body.direction, 'direction', ['long', 'short'] as const);
    const sides = await readSides(contract);
    const wanted = sides.filter((s) => s.size > 0 && (!direction || s.direction === direction));
    if (wanted.length === 0) throw new GateError(400, 'NO_POSITION', '当前没有持仓');

    const r = await flattenSides(contract, wanted, sides);
    res.json({ ok: true, ...r });
  }));

  /**
   * 触发单的价格和现价必须站在正确的一侧。
   * Gate 的触发单是「到条件就市价平」：多头把止损挂在现价上方，挂上去那一秒就成交了。
   * 所以先在服务端拦住，别等交易所平了仓再问为什么。
   *
   * 判定用最新成交价和标记价里更靠里的那个：触发单（price_type 0）看的是最新成交价，
   * 而标记价常常比它更靠里一点。只按标记价判，止损落在这两个价之间时照样一挂就成交 ——
   * 用户会看到「刚挂上就被平了」，那正是最难查的那种 bug。
   */
  function checkTriggerPrices(direction: Direction, low: number, high: number, stop: number, target: number): void {
    const below = low > 0 ? low : high;
    const above = high > 0 ? high : low;
    if (stop > 0) {
      if (direction === 'long' && !(stop < below)) {
        throw new GateError(400, 'BAD_STOP', `多头止损要低于现价 ${below}，挂在上方一挂上就成交`);
      }
      if (direction === 'short' && !(stop > above)) {
        throw new GateError(400, 'BAD_STOP', `空头止损要高于现价 ${above}，挂在下方一挂上就成交`);
      }
    }
    if (target > 0) {
      if (direction === 'long' && !(target > above)) {
        throw new GateError(400, 'BAD_TARGET', `多头止盈要高于现价 ${above}，否则一挂上就成交`);
      }
      if (direction === 'short' && !(target < below)) {
        throw new GateError(400, 'BAD_TARGET', `空头止盈要低于现价 ${below}，否则一挂上就成交`);
      }
    }
  }

  /**
   * 止损 / 止盈：Gate 的「价格触发单」。
   * 多头止损 rule=2（价格 <= 触发价），多头止盈 rule=1（价格 >= 触发价）。
   * 平仓靠 initial.auto_size=close_long / close_short，单仓和双向持仓都吃这套。
   * 老的 order_type: close-long-position 已被 Gate 废弃，传了报 1017。
   *
   * 每次挂都先撤掉这一边已有的触发单（覆盖语义）：不撤的话点两次「套用方案」
   * 就有两套止损，到价时几张单一起打，平出个反向仓来。
   * stop 和 target 都留空 = 只撤不挂，也就是不要保护。
   */
  interface BracketResult {
    created: { kind: string; id: string; triggerPrice: number }[];
    canceled: string[];
    errors: string[];
    size: number;
  }

  /** 按覆盖语义重挂这一边的止损止盈，开仓顺手挂的地方也走这里 */
  async function applyBracket(contract: string, dir: Direction, stopRaw: number, targetRaw: number): Promise<BracketResult> {
    const hasStop = Number.isFinite(stopRaw) && stopRaw > 0;
    const hasTarget = Number.isFinite(targetRaw) && targetRaw > 0;

    const sides = await readSides(contract);
    const mine = sides.find((s) => s.direction === dir && s.size > 0) ?? null;
    if (!mine && (hasStop || hasTarget)) {
      throw new GateError(400, 'NO_POSITION', `当前没有${dir === 'long' ? '多' : '空'}头持仓，先有仓才能挂止损止盈`);
    }
    const otherOpen = sides.some((s) => s.direction !== dir && s.size > 0);

    const c = await tradeContract(contract);
    const last = Number(c.last_price) || 0;
    const mark = mine && mine.markPrice > 0 ? mine.markPrice : last;

    const round = Number(c.order_price_round);
    const snap = (p: number) => (round > 0 ? Math.round(Math.round(p / round) * round * 1e8) / 1e8 : p);

    // 先吸附到最小变动价，再判方向：止损离现价不到一个 tick 时，
    // 吸附会把它推到现价上，按原值判「严格在下方」会放行，挂上去那一秒就成交。
    const stop = hasStop ? snap(stopRaw) : 0;
    const target = hasTarget ? snap(targetRaw) : 0;
    if (stop > 0 || target > 0) {
      checkTriggerPrices(dir, Math.min(last || mark, mark), Math.max(last, mark), stop, target);
    }

    const canceled: string[] = [];
    const errors: string[] = [];
    // 认不出方向的整边平仓单（交易所网页上挂的 isclose）在对边空着时也只可能属于这一边。
    // 只撤「减仓/平仓」这一类：交易所网页上挂的条件开仓单不归这里管，覆盖保护时不该顺手把它删了。
    const existing = (await readTriggers(contract)).filter(
      (t) => t.protective && (t.direction === dir || (t.direction === '' && t.closeAll && !otherOpen)),
    );
    const canceledIds = new Set<string>();
    for (const t of existing) {
      if (canceledIds.has(t.cancelId)) continue;
      canceledIds.add(t.cancelId);
      try {
        await exchange().cancelTrigger(t.cancelId);
        canceled.push(t.cancelId);
      } catch (e) {
        errors.push(`撤旧单 ${t.id}: ${e instanceof GateError ? `${e.label} ${e.detail}` : String(e)}`);
      }
    }

    const jobs: { kind: 'stop' | 'target'; price: number; rule: 1 | 2 }[] = [];
    if (stop > 0) jobs.push({ kind: 'stop', price: stop, rule: dir === 'long' ? 2 : 1 });
    if (target > 0) jobs.push({ kind: 'target', price: target, rule: dir === 'long' ? 1 : 2 });

    const created: { kind: string; id: string; triggerPrice: number }[] = [];
    for (const job of jobs) {
      try {
        const r = await exchange().placeTrigger({
          initial: {
            contract,
            size: 0,
            price: '0',
            tif: 'ioc',
            reduce_only: true,
            close: false,
            // auto_size 指明平哪一边，单仓和双向持仓都吃这套；isclose 在双向模式下有歧义
            auto_size: dir === 'long' ? 'close_long' : 'close_short',
          },
          trigger: { strategy: 0, price_type: 0, price: String(job.price), rule: job.rule, expiration: PROTECT_EXPIRATION_SEC },
        });
        created.push({ kind: job.kind, id: String(r.id), triggerPrice: job.price });
      } catch (e) {
        errors.push(`${job.kind}: ${e instanceof GateError ? `${e.label} ${e.detail}` : String(e)}`);
      }
    }

    // 想挂的没挂上就明说。只想撤的时候没撤掉也一样。
    if (jobs.length > 0 && created.length === 0 && errors.length > 0) {
      throw new GateError(400, 'BRACKET_FAILED', errors.join(' | '));
    }
    if (jobs.length === 0 && errors.length > 0) {
      throw new GateError(400, 'CANCEL_FAILED', errors.join(' | '));
    }
    return { created, canceled, errors, size: mine?.size ?? 0 };
  }

  /**
   * 开仓顺手挂保护。只有开了仓才挂得上，所以先读持仓再决定。
   * 限价单还没成交时返回 pending，前端记下来，等持仓出现再补挂。
   */
  async function attachAfterEntry(contract: string, dir: Direction, stop: number, target: number) {
    for (let i = 0; i < 3; i++) {
      const sides = await readSides(contract).catch(() => [] as Side[]);
      if (sides.some((s) => s.direction === dir && s.size > 0)) {
        try {
          const r = await applyBracket(contract, dir, stop, target);
          // 止损挂上、止盈没挂上也算「没挂全」。原来这里一律报 attached，
          // 页面就显示「保护单已挂」，可实际上少了一边 —— 止损没挂上是会赔钱的。
          return { status: r.errors.length > 0 ? ('partial' as const) : ('attached' as const), ...r };
        } catch (e) {
          return { status: 'failed' as const, error: e instanceof GateError ? `${e.label} ${e.detail}` : String(e) };
        }
      }
      if (i < 2) await new Promise((r) => setTimeout(r, 250));
    }
    return { status: 'pending' as const };
  }

  router.post('/bracket', wrap(async (req, res) => {
    requireArm(req);
    const body = bodyOf(req.body);
    const contract = requiredText(body.contract, 'contract', { max: 64 });
    const direction = oneOf(body.direction, 'direction', ['long', 'short'] as const);
    const stop = numberOr(body.stop, 'stop', 0, { min: 0 });
    const target = numberOr(body.target, 'target', 0, { min: 0 });
    const r = await applyBracket(contract, direction, stop, target);
    res.json({ ok: r.errors.length === 0, ...r });
  }));

  /**
   * 加仓：在已有那一侧按市价再加张数。
   * 张数只做交易所的最小/最大校验，不设仓位上限 —— 加多少该由当天的行情决定。
   * 单向模式下同方向的委托会直接加在现有仓上，双向模式下加在对应的那一侧。
   */
  router.post('/add-position', wrap(async (req, res) => {
    requireArm(req);
    const body = bodyOf(req.body);
    const contract = requiredText(body.contract, 'contract', { max: 64 });
    const dir = oneOf(body.direction, 'direction', ['long', 'short'] as const);
    const qty = Math.abs(requiredNumber(body.size, 'size', { positive: true }));
    const price = numberOr(body.price, 'price', 0, { min: 0 });

    const sides = await readSides(contract);
    const mine = sides.find((s) => s.direction === dir && s.size > 0);
    if (!mine) {
      throw new GateError(400, 'NO_POSITION', `当前没有${dir === 'long' ? '多' : '空'}头持仓。开新仓请用下单面板`);
    }

    const { prepared, order } = await placeOrder({ contract, side: dir, size: qty, price });
    res.json({
      ok: true,
      order: orderReceipt(order),
      added: qty,
      checked: { notional: Math.round(prepared.notional * 100) / 100, price: prepared.price },
    });
  }));

  /**
   * 反手：市价平掉这一边，再按同样的张数开反方向。
   * Gate 没有「一键反手」接口，只能两步。第一步没成交就停手 ——
   * 平仓没成功还去开反向，等于凭空多一倍仓，那是最糟的结果。
   */
  router.post('/reverse-position', wrap(async (req, res) => {
    requireArm(req);
    const body = bodyOf(req.body);
    const contract = requiredText(body.contract, 'contract', { max: 64 });
    const dir = oneOf(body.direction, 'direction', ['long', 'short'] as const);

    const sides = await readSides(contract);
    const mine = sides.find((s) => s.direction === dir && s.size > 0);
    if (!mine) {
      throw new GateError(400, 'NO_POSITION', `当前没有${dir === 'long' ? '多' : '空'}头持仓，没有可反的仓`);
    }
    // 不填张数就按当前持仓量反手
    const qty = Math.abs(optionalNumber(body.size, 'size', { positive: true }) ?? mine.size);
    if (qty > mine.size) {
      throw new GateError(400, 'REVERSE_SIZE_MAX', `反向张数不能超过当前持仓的 ${mine.size} 张。想加大请反手之后再点加仓`);
    }

    const opposite: Direction = dir === 'long' ? 'short' : 'long';
    const label = (d: Direction) => (d === 'long' ? '多' : '空');

    const close = await placeOrder({
      contract,
      side: dir,
      size: 0,
      autoSize: dir === 'long' ? 'close_long' : 'close_short',
    });
    const closeStatus = String(close.order.status ?? '');
    const closeLeft = Number(close.order.left ?? 0);
    const closedOut = String(close.order.finish_as ?? '') === 'filled' || (closeStatus === 'finished' && closeLeft === 0);
    if (!closedOut || closeLeft > 0) {
      throw new GateError(
        400,
        'REVERSE_STOPPED',
        `平${label(dir)}没有完全成交（剩 ${closeLeft} 张，状态 ${closeStatus || '未知'}），已经停手，没有开反方向`,
      );
    }

    // 平掉的那一边，委托和触发单跟着一起撤。不撤的话，同一秒反向开的仓一出现，
    // 旧止损（auto_size 平的是刚平掉的那一边，价格又刚好在现价这侧）就会把新仓打掉。
    // 这一边已经平干净了。反方向没有仓时整个合约就空着，可以一张不留地清干净。
    const canceled = await cancelSide(contract, [dir], !sides.some((s) => s.direction === opposite && s.size > 0));

    try {
      const { order } = await placeOrder({ contract, side: opposite, size: qty });
      res.json({
        ok: true,
        closed: { id: String(close.order.id), size: mine.size, status: closeStatus },
        opened: orderReceipt(order),
        direction: opposite,
        size: qty,
        canceled,
      });
    } catch (e) {
      const msg = e instanceof GateError ? `${e.label} ${e.detail}` : String(e);
      throw new GateError(
        500,
        'REVERSE_PARTIAL',
        `${label(dir)}已经平掉，反向开${label(opposite)} ${qty} 张失败：${msg}。现在这一边是空仓，请手动补一次`,
      );
    }
  }));

  router.delete('/price-order/:id', wrap(async (req, res) => {
    requireArm(req);
    const displayId = String(req.params.id);
    const trigger = (await readTriggers()).find((item) => item.id === displayId);
    await exchange().cancelTrigger(trigger?.cancelId ?? displayId);
    res.json({ ok: true });
  }));

  return { readAccount, readPositions, clearOrphanTriggers, ensureMarginMode, attachAfterEntry, placeOrder };
}
export type TradeServices = ReturnType<typeof mountTradeRoutes>;
