
/**
 * AI 交易的执行循环。
 *
 * 一个定时器，隔一会儿看一次：策略开着没有、这个合约到冷却了没有、账户还承受得起没有，
 * 然后对一个合约跑一次决策。决策 → 闸门 → （放行才）下单，三步都记进日志。
 *
 * 这一层的三条原则：
 *   1. **一次只做一个合约**。八个合约同时决策，账单是八倍，而账户只承受得起一单。
 *      轮着来，每次都挑最久没看过的那个。
 *   2. **开关关掉就真的什么都不做**：不发请求、不下单，也不再写日志。
 *      没有「只出建议」这种中间态 —— 停就是停。
 *   3. **任何一步出错只影响这一轮**：记下来，下一轮继续。AI 抽风不该把台子拖停。
 *
 * 这一层同样不碰「张数」：张数由 aiStrategy 的闸门算好递进来，这里只负责发单和记账。
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_DIR, config, envLabel } from './config.js';
import type { AiSnapshot, RoleTurn, TradePlan } from './ai.js';
import { conditionHolds, IndicatorCache, type Candle } from './quant/backtest.js';
import { buildAnonContext, assertAnonymous, parseVerdict } from './quant/promptStrategy.js';
import {
  dayLossPct, gatePlan, loadStrategy, noteEquity, saveStrategy,
  type GateOutcome, type StrategyConfig,
} from './aiStrategy.js';

/** 决策日志。一行一条，追加写；超过上限时裁到最近 N 条重写 */
export const AI_LOG_PATH = join(HOME_DIR, 'ai-decisions.jsonl');
const LOG_KEEP = 300;
const LOG_TRIM_AT = 600;

/** 定时器多久看一次。真正决定「多久做一次」的是每个合约的冷却时间 */
const TICK_MS = 30_000;
/** 任意两次决策之间至少隔这么久。模型调用是花钱的，别让冷却设成 0 就变成每 30 秒一次 */
const MIN_GAP_MS = 120_000;

export interface ContractMeta {
  multiplier: number;
  sizeMin: number;
  sizeMax: number;
  leverageMax: number;
  takerFee: number;
  lastPrice: number;
}

export interface ExecutedOrder {
  id: string;
  status: string;
  fillPrice: number;
  size: number;
  /** 止损止盈挂上了没有（attached / partial / pending / failed）。页面暂时只记进日志用 */
  bracket?: unknown;
}

export interface ExecRequest {
  contract: string;
  side: 'long' | 'short';
  size: number;
  leverage: number;
  marginMode: 'isolated' | 'cross';
  stop: number;
  target: number;
  entryType: 'market' | 'limit';
  entry: number | null;
}

/** 路由层递进来的东西。runner 自己不直接问交易所，好让这一层能单独测 */
export interface RunnerDeps {
  snapshot(contract: string, interval: string): Promise<AiSnapshot>;
  contractMeta(contract: string): Promise<ContractMeta>;
  account(): Promise<{ total: number; available: number }>;
  openPositions(): Promise<{ contract: string; direction: 'long' | 'short'; size: number }[]>;
  execute(req: ExecRequest): Promise<ExecutedOrder>;
  /**
   * 当前绑定的策略。
   *
   * 执行器自己不读策略库：它要知道的是"这一轮按哪条策略、在哪个币上跑"，
   * 而这件事由路由层统一裁决（策略没了、没达标，都在那里拦）。
   */
  binding(strategyId: string): {
    contract: string;
    interval: string;
    passed: boolean | null;
    failed: string[];
    enoughSample: boolean;
    kind: 'rule' | 'prompt';
    spec: import('./quant/backtest.js').StrategySpec | null;
    prompt: string | null;
  } | null;

  /**
   * 最近若干根已收盘 K 线。
   *
   * 规则策略要在上面算条件、提示词策略要在上面截匿名上下文 —— 两者都需要原始 K 线，
   * 而 snapshot（喂给旧七角色协议的那份）是加工过的摘要，不够用。
   */
  recentCandles(contract: string, interval: string, count: number): Promise<import('./quant/backtest.js').Candle[]>;

  /**
   * 问模型一句话，返回原话。
   *
   * 单独抽成依赖而不是在 runner 里直接 import：这样自检能塞一个假模型进来，
   * 不用为了一次决策去连真接口、花真钱。
   */
  askModel(system: string, user: string): Promise<string>;
}

export interface DecisionRecord {
  id: string;
  at: number;
  env: 'testnet' | 'live';
  envLabel: string;
  contract: string;
  interval: string;
  /** 这一轮按哪类策略做的决定。quick/standard/deep 那套已经不参与实盘了 */
  strategyKind: 'rule' | 'prompt';
  model: string;
  plan: TradePlan;
  gate: GateOutcome;
  exec: { ok: boolean; order?: ExecutedOrder; error?: string };
  turns: RoleTurn[];
  usage: { promptTokens: number; completionTokens: number; calls: number };
  ms: number;
}

function newId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** 从磁盘恢复最近的记录：重启之后页面上还看得见昨天做过什么 */
function readRecent(): DecisionRecord[] {
  if (!existsSync(AI_LOG_PATH)) return [];
  try {
    const lines = readFileSync(AI_LOG_PATH, 'utf8').split('\n').filter((l) => l.trim());
    const out: DecisionRecord[] = [];
    for (const line of lines.slice(-LOG_KEEP)) {
      try { out.push(JSON.parse(line) as DecisionRecord); } catch { /* 单行坏了就跳过 */ }
    }
    return out;
  } catch {
    return [];
  }
}

function appendRecord(rec: DecisionRecord): void {
  try {
    appendFileSync(AI_LOG_PATH, JSON.stringify(rec) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    // 写日志失败不该影响交易；但要说出来，否则页面上会「看着一切正常，其实什么都没记」
    console.warn('[ai] 决策日志写不进去：', (e as Error).message);
  }
}

function trimLogIfNeeded(): void {
  try {
    if (!existsSync(AI_LOG_PATH)) return;
    const lines = readFileSync(AI_LOG_PATH, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length <= LOG_TRIM_AT) return;
    writeFileSync(AI_LOG_PATH, lines.slice(-LOG_KEEP).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch { /* 裁不掉就算了，下次再试 */ }
}

export interface RunnerStatus {
  enabled: boolean;
  running: boolean;
  /** 正在跑一轮决策 */
  busy: boolean;
  env: 'testnet' | 'live';
  envLabel: string;
  strategy: StrategyConfig;
  /** 下一次定时器什么时候醒（毫秒时间戳） */
  nextTickAt: number;
  lastTickAt: number;
  /** 上一次真的做过决策的时间（任意合约） */
  lastDecisionAt: number;
  /** 这一轮为什么什么都没做（仓位满了、都在冷却……） */
  skip: string;
  dayLossPct: number;
  haltReason: string;
  haltUntil: number;
  counts: { decisions: number; orders: number; refusals: number; errors: number };
  positions: number;
  lastError: string;
}

/**
 * 执行器。
 *
 * 定时器和「立即决策一次」共用同一个 tick：两条路径同时进来时，busy 会把后进来的挡住 ——
 * 一次点击不该变成两份账单，也更不该变成两张方向相反的单。
 */
export class AiRunner {
  private deps: RunnerDeps;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastDecideAt = new Map<string, number>();
  private lastDecisionAt = 0;
  private lastTickAt = 0;
  private nextTickAt = 0;
  private skip = '';
  private recent: DecisionRecord[] = [];
  private counts = { decisions: 0, orders: 0, refusals: 0, errors: 0 };
  private lastError = '';
  private positionsNow = 0;
  private dayLoss = 0;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.recent = readRecent();
    // 重启之后冷却时间还应该生效：拿日志里每个合约最后一次的时间填回去
    for (const r of this.recent) {
      const prev = this.lastDecideAt.get(r.contract) ?? 0;
      if (r.at > prev) this.lastDecideAt.set(r.contract, r.at);
      if (r.at > this.lastDecisionAt) this.lastDecisionAt = r.at;
      this.counts.decisions += 1;
      if (r.exec?.ok) this.counts.orders += 1;
      else if (r.gate?.refusals?.length) this.counts.refusals += 1;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // unref：这个定时器不该把进程钉住（服务端退出时能正常退）
    this.timer.unref?.();
    this.nextTickAt = Date.now() + TICK_MS;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.nextTickAt = 0;
  }

  /** 最近做过什么。页面直接渲染这个 */
  records(limit = 40): DecisionRecord[] {
    return this.recent.slice(-limit).reverse();
  }

  status(): RunnerStatus {
    const cfg = loadStrategy();
    return {
      enabled: cfg.enabled,
      running: Boolean(this.timer),
      busy: this.busy,
      env: config.env,
      envLabel: envLabel(),
      strategy: cfg,
      nextTickAt: this.nextTickAt,
      lastTickAt: this.lastTickAt,
      lastDecisionAt: this.lastDecisionAt,
      skip: this.skip,
      dayLossPct: Number(this.dayLoss.toFixed(2)),
      haltReason: cfg.haltReason,
      haltUntil: cfg.haltUntil,
      counts: { ...this.counts },
      positions: this.positionsNow,
      lastError: this.lastError,
    };
  }

  /**
   * 跑一轮。
   *
   * force=true 是页面上的「立即决策一次」：跳过冷却和两分钟间隔，但仍然要求策略是开着的 ——
   * 「关着的时候帮忙看一眼」就是建议单，那个东西这里没有。
   */
  async tick(force = false): Promise<DecisionRecord | null> {
    if (this.busy) return null;
    this.busy = true;
    this.lastTickAt = Date.now();
    const t0 = Date.now();
    try {
      const cfg = loadStrategy();
      if (!cfg.enabled) {
        this.skip = '策略没开';
        return null;
      }

      /**
       * 策略必须存在、跑过回测、样本够、而且达标。
       *
       * 这一道不能松：AI 下单依据的是"这条规则在这个币上验证过"，
       * 任何一条不满足，下单就变成拍脑袋。拦下来时把原因写进 skip，
       * 页面上直接显示，而不是一个沉默的停摆。
       */
      if (!cfg.strategyId) {
        this.skip = '还没选策略';
        return null;
      }
      const bound = this.deps.binding(cfg.strategyId);
      if (!bound) {
        this.skip = '选中的策略已经不在了，重新选一条';
        return null;
      }
      if (bound.passed === null) {
        this.skip = '这条策略还没跑过回测，先到「策略」页跑一次';
        return null;
      }
      if (!bound.enoughSample) {
        this.skip = '回测样本不够，判定不可信，不能下单';
        return null;
      }
      if (!bound.passed) {
        this.skip = '这条策略上次回测没过：' + (bound.failed.join('、') || '原因不明');
        return null;
      }

      if (cfg.haltUntil > Date.now()) {
        this.skip = '熔断中：' + (cfg.haltReason || '日内亏损到上限');
        return null;
      }
      if (!force && Date.now() - this.lastDecisionAt < MIN_GAP_MS) {
        this.skip = '距离上一次决策不到两分钟';
        return null;
      }

      const account = await this.deps.account();
      // 当天第一次拿到账户数据就记下基准；之后不再改，否则跌下去的那一段会被抹平
      const withDay = noteEquity(cfg, account.total);
      if (withDay !== cfg) saveStrategy(withDay);
      const loss = dayLossPct(withDay, account.total);
      this.dayLoss = loss;
      if (loss >= withDay.maxDailyLossPct) {
        const until = new Date();
        until.setHours(24, 0, 0, 0);
        saveStrategy({
          ...withDay,
          haltReason: '今天亏了 ' + loss.toFixed(2) + '%，超过上限 ' + withDay.maxDailyLossPct + '%',
          haltUntil: until.getTime(),
        });
        this.skip = '日内亏损到上限，已熔断';
        return null;
      }

      const positions = await this.deps.openPositions().catch(() => []);
      this.positionsNow = positions.length;
      if (positions.length >= withDay.maxPositions) {
        this.skip = '已经有 ' + positions.length + ' 个持仓，到上限了';
        return null;
      }

      /**
       * 合约从配置里的合约池取，池子是空的才退回策略上记的那个。
       *
       * 这里以前写死 bound.contract，导致 AI 交易页上的「合约」那一格完全没作用 ——
       * 页面改了、存了、显示也变了，实际下单永远还是策略存的时候那个币。
       * 现在池子里挑一个还没有持仓的；都满了就退到第一个。
       */
      const pool = withDay.contracts.length > 0 ? withDay.contracts : [bound.contract];
      const contract = pool.find((c) => !positions.some((p) => p.contract === c)) ?? pool[0]!;
      const cooldown = Math.max(1, withDay.cooldownMin) * 60_000;
      const now = Date.now();
      if (positions.some((p) => p.contract === contract)) {
        this.skip = contract + ' 上已经有仓了';
        return null;
      }
      if (!force && now - (this.lastDecideAt.get(contract) ?? 0) < cooldown) {
        const wait = Math.max(1, Math.round((cooldown - (now - (this.lastDecideAt.get(contract) ?? 0))) / 60_000));
        this.skip = '还在冷却，' + wait + ' 分钟后可以再看';
        return null;
      }
      this.skip = '';
      this.lastDecideAt.set(contract, now);

      // 周期也跟着策略走：策略是在某个周期上训练的，拿别的周期跑等于换了策略
      const rec = await this.runOne(withDay, contract, bound.interval, bound, account, positions, t0);
      // 这一轮跑通了，把上一次的错清掉 —— 否则那一行会一直挂着，像是「现在还在出错」
      this.lastError = '';
      return rec;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.counts.errors += 1;
      console.warn('[ai] 这一轮没跑成：', this.lastError);
      return null;
    } finally {
      this.busy = false;
      this.lastTickAt = Date.now();
      trimLogIfNeeded();
    }
  }

  /**
   * 一轮决策。
   *
   * **方向由策略决定，不由模型自由发挥。**
   *
   * 这是相对早期版本最大的改动：以前这里固定调 decide() 那套七角色协议，
   * 用户选的策略只决定「能不能开」，开了之后按什么判断根本没人管。
   * 现在按 kind 分流：
   *   · rule   —— 在最近一根已收盘 K 线上算条件，命中就按 spec.side 做，全程不问模型
   *   · prompt —— 把最近几十根匿名化后交给模型，它只回 long/short/flat，一次调用
   *
   * 两种情况下，入场价、止损、止盈都由策略算（规则策略用它的 spec，提示词策略用固定的
   * ATR 2 倍止损 + 盈亏比 2），模型不碰价格 —— 和回测完全一致，回测得出的结论才代表实盘。
   */
  private async runOne(
    cfg: StrategyConfig,
    contract: string,
    interval: string,
    bound: NonNullable<ReturnType<RunnerDeps['binding']>>,
    account: { total: number; available: number },
    positions: { contract: string }[],
    t0: number,
  ): Promise<DecisionRecord> {
    const snapshot = await this.deps.snapshot(contract, interval);
    const call = await this.directionOf(bound, contract, interval, snapshot);

    const meta = await this.deps.contractMeta(contract).catch(() => null);
    const gate: GateOutcome = meta
      ? gatePlan(cfg, {
          plan: call.plan,
          market: { last: snapshot.last, atr: snapshot.atr },
          info: meta,
          account,
          openPositions: positions.length,
          contractHasPosition: false,
          dayLossPct: this.dayLoss,
        })
      : {
          ok: false, action: call.plan.action, size: 0, notional: 0, margin: 0,
          riskUsd: 0, stopDistance: 0, rr: 0, binding: '',
          checks: [{ label: '合约参数', ok: false, detail: '拿不到这个合约的乘数和最小下单量' }],
          refusals: ['合约参数：拿不到这个合约的乘数和最小下单量'], warnings: [],
        };

    const rec: DecisionRecord = {
      id: newId(),
      at: Date.now(),
      env: config.env,
      envLabel: envLabel(),
      contract,
      interval,
      strategyKind: bound.kind,
      model: call.model,
      plan: call.plan,
      gate,
      exec: { ok: false },
      turns: call.turns,
      usage: call.usage,
      ms: Date.now() - t0,
    };

    if (gate.ok) {
      // 两道额外的门：服务端的全局下单开关，和实盘确认。都在闸门之后 ——
      // 闸门放行的是「这一单符合策略」，这两道管的是「这个账户现在能不能动」
      if (!config.liveTrading) {
        rec.exec = { ok: false, error: '服务端下单开关（LIVE_TRADING）是关的，这一单没发出去' };
      } else if (config.env === 'live' && !cfg.liveConfirmed) {
        rec.exec = { ok: false, error: '当前是实盘，但还没有在 AI 交易页确认实盘下单' };
      } else {
        try {
          const order = await this.deps.execute({
            contract,
            side: gate.action === 'short' ? 'short' : 'long',
            size: gate.size,
            leverage: Math.max(1, Math.min(cfg.leverage, meta?.leverageMax || cfg.leverage)),
            marginMode: cfg.marginMode,
            stop: call.plan.stop ?? 0,
            target: call.plan.target ?? 0,
            entryType: call.plan.entryType,
            entry: call.plan.entry,
          });
          rec.exec = { ok: true, order };
          this.counts.orders += 1;
        } catch (e) {
          // 交易所拒单、保证金不够、模式切不过去 —— 都落在这里，原话保留
          rec.exec = { ok: false, error: (e as Error).message };
        }
      }
    } else {
      this.counts.refusals += 1;
    }

    this.counts.decisions += 1;
    this.lastDecisionAt = rec.at;
    this.recent.push(rec);
    if (this.recent.length > LOG_KEEP) this.recent = this.recent.slice(-LOG_KEEP);
    appendRecord(rec);
    return rec;
  }

  /**
   * 按策略算方向。
   *
   * 规则策略完全不问模型 —— 条件是代码算的，问模型只是多花一笔钱、多一个不确定源。
   * 提示词策略问一次，且问之前先确认上下文里没有身份信息。
   */
  private async directionOf(
    bound: NonNullable<ReturnType<RunnerDeps['binding']>>,
    contract: string,
    interval: string,
    snapshot: AiSnapshot,
  ): Promise<{
    plan: TradePlan;
    turns: RoleTurn[];
    usage: { promptTokens: number; completionTokens: number; calls: number };
    model: string;
  }> {
    const now = Date.now();
    const turn = (label: string, text: string): RoleTurn => ({ role: 'strategy', label, text, at: now, ok: true });
    const zero = { promptTokens: 0, completionTokens: 0, calls: 0 };

    /** 不做。reasoning 会原样显示在决策流里，得说人话 */
    const hold = (why: string, turns: RoleTurn[], usage = zero, model = '策略'): {
      plan: TradePlan; turns: RoleTurn[]; usage: typeof zero; model: string;
    } => ({
      plan: {
        action: 'hold', confidence: 0, entry: null, entryType: 'market',
        stop: null, target: null, horizonHours: 0,
        reasoning: why, reasons: [], conflicts: [why], vetoes: [], riskNote: '',
      },
      turns, usage, model,
    });

    // ---------- 规则策略：条件算 ----------
    if (bound.kind === 'rule') {
      const spec = bound.spec;
      if (!spec || !Array.isArray(spec.entry) || spec.entry.length === 0) {
        return hold('策略没有入场条件', [turn('策略', '这条策略没有条件，什么都不做')]);
      }

      const candles = await this.deps.recentCandles(contract, interval, 400).catch(() => [] as Candle[]);
      if (candles.length < 30) {
        return hold('K 线太少，算不出条件', [turn('策略', '只拿到 ' + candles.length + ' 根 K 线')]);
      }

      // 用最后一根**已收盘**的 K 线判断，和回测里「第 i 根收盘做决定」是同一条规则
      const i = candles.length - 1;
      const cache = new IndicatorCache(candles);
      const holds = spec.entry.every((c) => conditionHolds(c, i, cache, spec.params));
      const condText = spec.entry
        .map((c) => c.left.name + (c.shift ? '[t-' + c.shift + ']' : '') + ' ' + c.op + ' ' + (c.rightParam ?? c.right.name))
        .join(' 且 ');

      if (!holds) {
        return hold('条件没有全部满足：' + condText, [turn('规则条件', '未命中：' + condText)]);
      }

      const levels = this.levelsFor(spec.stop, spec.target, spec.side, snapshot);
      if (!levels) {
        return hold('ATR 不可用，算不出止损距离', [turn('规则条件', '命中，但 ATR 拿不到')]);
      }
      return {
        plan: {
          action: spec.side,
          confidence: 1,
          entry: null,
          entryType: 'market',
          stop: levels.stop,
          target: levels.target,
          horizonHours: 0,
          reasoning: '规则命中：' + condText,
          reasons: ['条件全部满足：' + condText],
          conflicts: [],
          vetoes: [],
          riskNote: '',
        },
        turns: [turn('规则条件', '命中：' + condText + ' → ' + (spec.side === 'long' ? '做多' : '做空'))],
        usage: zero,
        model: '规则策略（未调用模型）',
      };
    }

    // ---------- 提示词策略：问一次模型 ----------
    const prompt = bound.prompt;
    if (!prompt) {
      return hold('策略没有提示词', [turn('策略', '这条提示词策略是空的')]);
    }
    const candles = await this.deps.recentCandles(contract, interval, 160).catch(() => [] as Candle[]);
    if (candles.length < 50) {
      return hold('K 线太少，截不出上下文', [turn('提示词', '只拿到 ' + candles.length + ' 根 K 线')]);
    }

    const ctx = buildAnonContext(candles, candles.length - 1, 40);
    // 发出去之前先确认没夹带身份信息。回测里这样做，实盘也必须这样做 ——
    // 两边看到的输入不一致的话，回测那套结论就不代表实盘
    const forbidden = ['USDT', 'GATE', contract.split('_')[0] ?? ''];
    try {
      assertAnonymous(ctx.text + String.fromCharCode(10) + prompt, forbidden);
    } catch (e) {
      return hold('匿名化没做干净，拒绝执行：' + (e as Error).message, [turn('提示词', '上下文检查未通过')]);
    }

    let raw = '';
    let calls = 1;
    try {
      raw = await this.deps.askModel(prompt, ctx.text);
    } catch (e) {
      return hold('问模型失败：' + (e as Error).message, [turn('提示词', '调用失败')], { promptTokens: 0, completionTokens: 0, calls }, '提示词策略');
    }

    const v = parseVerdict(raw);
    const modelTurn = turn('提示词策略', '模型回：' + (raw.trim().slice(0, 200) || '（空）'));
    if (v.side === 'flat') {
      return hold('模型判不做', [modelTurn], { promptTokens: 0, completionTokens: 0, calls }, '提示词策略');
    }

    const levels = this.levelsFor({ kind: 'atr', value: 2 }, { kind: 'rr', value: 2 }, v.side, snapshot);
    if (!levels) {
      return hold('ATR 不可用，算不出止损距离', [modelTurn], { promptTokens: 0, completionTokens: 0, calls }, '提示词策略');
    }
    return {
      plan: {
        action: v.side,
        confidence: v.confidence ?? 0.6,
        entry: null,
        entryType: 'market',
        stop: levels.stop,
        target: levels.target,
        horizonHours: 0,
        reasoning: '提示词策略判 ' + (v.side === 'long' ? '做多' : '做空'),
        reasons: [],
        conflicts: [],
        vetoes: [],
        riskNote: '',
      },
      turns: [modelTurn],
      usage: { promptTokens: 0, completionTokens: 0, calls },
      model: '提示词策略',
    };
  }

  /**
   * 按策略的离场规则算止损止盈价。
   *
   * 和回测 engine 里 stopDistance/targetDistance 是同一套算法 ——
   * 两边算出来不一样的话，回测统计的那些盈亏比就代表不了实盘。
   */
  private levelsFor(
    stopRule: { kind: 'atr' | 'pct'; value: number },
    targetRule: { kind: 'atr' | 'pct' | 'rr'; value: number },
    side: 'long' | 'short',
    snapshot: AiSnapshot,
  ): { stop: number; target: number } | null {
    const last = snapshot.last;
    const atr = snapshot.atr;
    if (!(last > 0)) return null;
    if ((stopRule.kind === 'atr' || targetRule.kind === 'atr') && !(atr > 0)) return null;

    const stopDist = stopRule.kind === 'pct' ? last * stopRule.value : atr * stopRule.value;
    const targetDist = targetRule.kind === 'pct'
      ? last * targetRule.value
      : targetRule.kind === 'rr'
        ? stopDist * targetRule.value
        : atr * targetRule.value;
    if (!(stopDist > 0) || !(targetDist > 0)) return null;

    const round = (v: number) => Number(v.toPrecision(8));
    return {
      stop: round(side === 'long' ? last - stopDist : last + stopDist),
      target: round(side === 'long' ? last + targetDist : last - targetDist),
    };
  }
}