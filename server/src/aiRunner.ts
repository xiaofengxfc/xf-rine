
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
import { decide, type AiDecision, type AiSnapshot, type RoleTurn, type TradePlan } from './ai.js';
import {
  dayLossPct, gatePlan, loadStrategy, noteEquity, saveStrategy,
  type Depth, type GateOutcome, type StrategyConfig,
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
  binding(strategyId: string): { contract: string; interval: string; passed: boolean | null; failed: string[]; enoughSample: boolean } | null;
}

export interface DecisionRecord {
  id: string;
  at: number;
  env: 'testnet' | 'live';
  envLabel: string;
  contract: string;
  interval: string;
  depth: Depth;
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
       * 合约池 = 这条策略训练时用的那个币。
       *
       * 不再是"用户填一串合约、轮着做"。策略是在某一个币上搜索参数、样本外判定通过的，
       * 换币就没有依据了。想多做几个币，就各自训练各自开的策略。
       */
      const contract = bound.contract;
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
      const rec = await this.runOne(withDay, contract, bound.interval, account, positions, t0);
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

  private async runOne(
    cfg: StrategyConfig,
    contract: string,
    interval: string,
    account: { total: number; available: number },
    positions: { contract: string }[],
    t0: number,
  ): Promise<DecisionRecord> {
    const snapshot = await this.deps.snapshot(contract, interval);
    const decision: AiDecision = await decide(snapshot, { depth: cfg.depth });

    const meta = await this.deps.contractMeta(contract).catch(() => null);
    const gate: GateOutcome = meta
      ? gatePlan(cfg, {
          plan: decision.plan,
          market: { last: snapshot.last, atr: snapshot.atr },
          info: meta,
          account,
          openPositions: positions.length,
          contractHasPosition: false,
          dayLossPct: this.dayLoss,
        })
      : {
          ok: false, action: decision.plan.action, size: 0, notional: 0, margin: 0,
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
      depth: cfg.depth,
      model: decision.model,
      plan: decision.plan,
      gate,
      exec: { ok: false },
      turns: decision.turns,
      usage: decision.usage,
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
            stop: decision.plan.stop ?? 0,
            target: decision.plan.target ?? 0,
            entryType: decision.plan.entryType,
            entry: decision.plan.entry,
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
}
