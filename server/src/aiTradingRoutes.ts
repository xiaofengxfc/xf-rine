import { Router, type Request, type Response } from 'express';
import { config } from './config.js';
import { GateError } from './exchange/errors.js';
import { exchange } from './exchange/index.js';
import type { XContract } from './exchange/types.js';
import type { Bar } from './bar.js';
import { AiRunner, type ExecRequest, type RunnerDeps } from './aiRunner.js';
import { AI_STRATEGY_PATH, loadStrategy, saveStrategy, sanitizeStrategy } from './aiStrategy.js';
import { checkRunnable, bindingOf } from './aiStrategy.js';
import { getStrategy as getSavedStrategy, listStrategies as listSavedStrategies } from './quant/library.js';
import { chatJson, type AiSnapshot } from './ai.js';
import type { Direction } from './sr/types.js';
import type { TradeServices } from './tradeRoutes.js';

interface AiTradingRouteDeps {
  wrap: (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => void;
  requireLocal: (req: Request, what: string) => void;
  tradeServices: TradeServices;
  tradeContract(name: string): Promise<XContract>;
  buildSnapshot(contract: string, interval: string): Promise<AiSnapshot>;
  loadCandles(contract: string, interval: string, count: number): Promise<{ bars: Bar[] }>;
  tradableNames(): Promise<Set<string> | null>;
}

export function mountAiTradingRoutes(router: Router, deps: AiTradingRouteDeps) {
  const { wrap, requireLocal, tradeServices, tradeContract, buildSnapshot, loadCandles, tradableNames } = deps;
  // ---------- AI 交易（/ai/strategy、/ai/decide、/ai/decisions、/ai/status） ----------

  /**
   * 执行器要用的四件事，全部走这里已有的那几段代码。
   *
   * 放在文件末尾是为了避开 const 的暂时性死区：buildSnapshot / placeOrder /
   * ensureMarginMode / attachAfterEntry / readAccount / readPositions 都在上面定义，
   * 在它们之前实例化会启动即 ReferenceError（和研究台那段同一个理由）。
   */
  const aiDeps: RunnerDeps = {
    snapshot: (contract, interval) => buildSnapshot(contract, interval),

    contractMeta: async (contract) => {
      const c = await tradeContract(contract);
      return {
        multiplier: Number(c.quanto_multiplier),
        sizeMin: Number(c.order_size_min),
        sizeStep: Number(c.size_step) > 0 ? Number(c.size_step) : 1,
        sizeMax: Number(c.order_size_max),
        leverageMax: Number(c.leverage_max),
        takerFee: Number(c.taker_fee_rate),
        lastPrice: Number(c.last_price),
      };
    },

    account: async () => {
      const a = await tradeServices.readAccount();
      return { total: a.total, available: a.available };
    },

    /**
     * 把 strategyId 翻成"哪个币、什么周期、过没过回测"。
     *
     * 执行器每一轮都要问一次，所以这里只读本地 JSON，不碰交易所 —— 一次读几 KB，
     * 比让执行器自己缓存一份"策略可能已经被改了"的副本安全。
     */
    binding: (strategyId: string) => {
      const saved = getSavedStrategy(strategyId);
      if (!saved) return null;
      return {
        contract: saved.lastRun?.contract ?? saved.contract,
        interval: saved.lastRun?.interval ?? saved.interval,
        passed: saved.lastRun ? saved.lastRun.passed : null,
        failed: saved.lastRun ? saved.lastRun.failed : [],
        enoughSample: saved.lastRun ? saved.lastRun.enoughSample : false,
        testedContract: saved.lastRun?.contract ?? '',
        testedInterval: saved.lastRun?.interval ?? '',
        // 策略类型决定实盘怎么出方向 —— 这两条以前缺失，导致执行器只会走那套旧协议
        kind: saved.kind,
        spec: saved.spec,
        prompt: saved.prompt,
        risk: saved.risk,
      };
    },

    /**
     * 最近若干根已收盘 K 线，转成回测引擎用的形状。
     *
     * 去掉最后一根：它还没走完，最高最低还会变，拿它判断条件等于用未完成的数据做决定。
     */
    recentCandles: async (contract: string, interval: string, count: number) => {
      const { bars } = await loadCandles(contract, interval, count);
      return bars.slice(0, -1).map((b) => ({
        t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
      }));
    },

    askModel: async (system: string, user: string) => {
      const r = await chatJson({ system, user, maxTokens: 300, timeoutMs: 60_000 });
      return r.text;
    },

    openPositions: async () => {
      const list = await tradeServices.readPositions();
      // Direction 这个类型里还有 'both'（引擎那边分方向用的），这里只要多空两边
      return list.map((p) => ({
        contract: p.contract,
        direction: (p.direction === 'short' ? 'short' : 'long') as 'long' | 'short',
        size: p.size,
      }));
    },

    /**
     * 发单。和 POST /order 走同一条路：清孤儿触发单 → 定保证金模式 → 验参下单 → 挂保护。
     *
     * 不一样的地方只有一处：这里没有 x-arm-token。AI 拿不到浏览器那把锁，
     * 它的授权是「AI 交易页上的开关」加上下面那两道门（服务端下单开关、实盘确认）。
     */
    execute: async (req: ExecRequest) => {
      const dir: Direction = req.side === 'short' ? 'short' : 'long';
      // 开仓前先把这一边没人管的触发单清掉，否则新仓一出现就会被上一个仓的遗物打掉
      await tradeServices.clearOrphanTriggers(req.contract, dir).catch(() => [] as string[]);
      // 模式设不成就不发单：逐仓的止损要建立在「亏损不会越过这一笔保证金」上
      await tradeServices.ensureMarginMode(req.contract, dir, req.leverage, req.marginMode);
      const isLimit = req.entryType === 'limit' && req.entry !== null && req.entry > 0;
      const { prepared, order } = await tradeServices.placeOrder({
        contract: req.contract,
        side: dir,
        size: req.size,
        price: isLimit ? (req.entry ?? 0) : 0,
        tif: isLimit ? 'gtc' : undefined,
      });
      // 限价单还没成交时这里会返回 pending，AI 不做「等它成交再补挂」那一套：
      // 限价单的成交与否属于下一轮判断，写进回执让页面看见就行
      const bracket = (req.stop > 0 || req.target > 0)
        ? await tradeServices.attachAfterEntry(req.contract, dir, req.stop, req.target)
        : null;
      return {
        id: String(order.id),
        // Gate 的市价单会直接回 fill_as（ioc 成交完就是 'ioc'），挂单才是 'open'
        status: String(order.fill_as ?? order.status ?? 'open'),
        fillPrice: Number(order.fill_price ?? 0) || prepared.price,
        size: Math.abs(Number(order.size ?? 0)),
        bracket,
      };
    },
  };

  const aiRunner = new AiRunner(aiDeps);
  // 定时器先起着：策略没开的时候它每 30 秒只读一次那个小 JSON，什么都不做。
  // 不这么写的话，「打开开关」那次请求之后的第一个决策要等用户手动点一次才开始。
  aiRunner.start();

  /** 把策略和状态一起给出去：页面只需要一次请求就能把整块画出来 */
  const aiPayload = () => ({
    strategy: loadStrategy(),
    status: aiRunner.status(),
    /** 策略库：页面上的"选策略"格子里要列出来 */
    strategies: listSavedStrategies(),
    /** 当前绑定的那条策略的细节（合约、周期、上次回测过没过），没选就是 null */
    binding: (() => {
      const id = loadStrategy().strategyId;
      const s = id ? getSavedStrategy(id) : null;
      return s ? bindingOf(s) : null;
    })(),
    path: AI_STRATEGY_PATH,
    ai: { configured: Boolean(config.ai.apiKey), baseUrl: config.ai.baseUrl, model: config.ai.model },
    liveTrading: config.liveTrading,
  });

  router.get('/ai/strategy', (req, res) => {
    res.json(aiPayload());
  });

  /**
   * 写策略。这一格管的是钱，所以：
   *   · 只认本机（和写密钥、选数据目录同一个理由）；
   *   · 打开开关之前先验「能不能交易」：AI 没配、密钥没填、实盘没确认，一律拒，并说清是哪一条。
   *
   * 注意没有「只出建议」这个档。开关是二值的：开着就按策略下单，关掉就一个请求都不发。
   */
  router.post('/ai/strategy', wrap(async (req, res) => {
    requireLocal(req, '改 AI 策略');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = loadStrategy();
    const merged = sanitizeStrategy(body, current);
    // 熔断是运行期状态，不该由页面顺手改掉；要解只能在页面上明确点「解除熔断」
    merged.haltReason = body.resetHalt === true ? '' : current.haltReason;
    merged.haltUntil = body.resetHalt === true ? 0 : current.haltUntil;
    merged.dayKey = current.dayKey;
    merged.dayStartEquity = current.dayStartEquity;

    /**
     * 合约池和周期**永远**由策略决定，不管开没开。
     *
     * 放在 if (enabled) 里面是错的：关着的时候页面显示的空合约池就是真的空，
     * 打开开关那一次才落定，中间那段显示的状态和实际要跑的不是一回事。
     * 而且页面直接传的 contracts 一律不认 —— 上面那句 sanitize 里读的是调用方给的，
     * 这里再覆盖一次，确保"只有策略能决定在哪个币上跑"。
     */
    /*
     * 策略不再锁死币种。
     *
     * 以前这里强制 merged.contracts = [bound.contract]，理由是"策略只在训练过的币上有依据"。
     * 现在放开：换币是合理需求（同一套规则想在别的品种上看看）。
     * 但"依据变弱"这件事不能悄悄吞掉 —— 页面上会并排显示
     * 「策略上次回测的合约」和「现在要跑的合约」，不一致就提示重跑一次。
     * 策略上没记合约时，才用策略的默认合约兜底。
     */
    const bound = merged.strategyId ? getSavedStrategy(merged.strategyId) : null;
    if (bound && merged.contracts.length === 0) {
      merged.contracts = [bound.lastRun?.contract ?? bound.contract];
    }

    if (merged.enabled) {
      if (!config.ai.apiKey) {
        throw new GateError(400, 'AI_NOT_CONFIGURED', '还没有配置 AI 密钥（设置页 → AI），没有模型就没法决策');
      }

      /**
       * 必须先选一条过了回测的策略。
       *
       * 这一条替代了原来那句「合约池是空的」。区别在于：以前合约池是手填的，
       * 填什么就能拿什么下单；现在合约池由策略决定，而策略必须先在回测里达标。
       * "选一条策略"和"决定在哪个币上跑"是同一件事，不该分两步问。
       */
      const gate = checkRunnable(merged, bound ? bindingOf(bound) : null);
      if (!gate.ok) {
        throw new GateError(400, 'STRATEGY_NOT_READY', gate.reason);
      }

      /**
       * 合约得在当前环境里真的能交易。
       *
       * 模拟盘只上架几十个合约，主网一千多 —— 在模拟盘里选一个只在主网有的合约，
       * 前面一路绿灯，直到下单那一刻才被交易所回一句 CONTRACT_NOT_FOUND。
       * 在这里一次说清，比让用户猜「哪个环节不认这个币」强。
       */
      if (merged.contracts.length > 0) {
        const tradable = await tradableNames().catch(() => null);
        if (tradable) {
          const missing = merged.contracts.filter((c) => !tradable.has(c));
          if (missing.length > 0) {
            throw new GateError(
              400, 'CONTRACT_NOT_TRADABLE',
              (config.env === 'testnet' ? '模拟盘' : '实盘') + '上没有 ' + missing.join('、')
              + ' 这个合约。模拟盘只上架了几十个，换一个，或者先切到实盘再开',
            );
          }
        }
      }

      exchange().requireKeys();
      if (config.env === 'live' && !merged.liveConfirmed) {
        throw new GateError(
          400, 'LIVE_NOT_CONFIRMED',
          '当前是实盘。要让 AI 用真钱下单，得先在这一页勾上「确认实盘」—— 换环境会把它清掉',
        );
      }
      if (merged.haltUntil > Date.now()) {
        throw new GateError(
          400, 'HALTED',
          '还在熔断中：' + (merged.haltReason || '日内亏损到上限') + '。要重新开始，先点「解除熔断」',
        );
      }
    }

    const saved = saveStrategy(merged);
    if (saved.enabled) aiRunner.start();
    else aiRunner.stop();
    res.json({ ok: true, ...aiPayload() });
  }));

  router.get('/ai/status', (_req, res) => {
    res.json({ ...aiPayload(), recent: aiRunner.records(1) });
  });

  router.get('/ai/decisions', (req, res) => {
    const n = Math.min(200, Math.max(1, Number(req.query.limit ?? 40) || 40));
    res.json({ records: aiRunner.records(n), status: aiRunner.status() });
  });

  /**
   * 立即决策一次。
   *
   * 只在策略开着的时候可用。关着的时候「帮你看一眼」就是建议单 —— 那个东西这里不做，
   * 所以这里直接拒，而不是悄悄跑一次然后把结论摆出来。
   */
  router.post('/ai/decide', wrap(async (_req, res) => {
    const cfg = loadStrategy();
    if (!cfg.enabled) throw new GateError(400, 'AI_DISABLED', 'AI 交易没开。先在这一页打开开关，它才会决策');
    const rec = await aiRunner.tick(true);
    if (!rec) {
      res.json({ ok: false, skip: aiRunner.status().skip, status: aiRunner.status() });
      return;
    }
    res.json({ ok: true, record: rec, ...aiPayload() });
  }));

  /**
   * 急停：关掉开关、停掉定时器，但保留日志和策略 —— 回来还能接着用。
   * 这和「切环境」不一样：那个连实盘确认一起清掉，这个是暂时的。
   */
  router.post('/ai/halt', wrap(async (req, res) => {
    requireLocal(req, '停 AI 交易');
    aiRunner.stop();
    const cfg = loadStrategy();
    const halt = (req.body ?? {}).halt === true;
    const saved = saveStrategy(
      halt
        ? { ...cfg, enabled: false, haltReason: '手动急停', haltUntil: Date.now() + 24 * 3600_000 }
        : { ...cfg, enabled: false },
    );
    res.json({ ok: true, strategy: saved, status: aiRunner.status() });
  }));



  return { aiRunner };
}
