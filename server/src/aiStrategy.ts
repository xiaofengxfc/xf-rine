/**
 * AI 交易的策略配置，和它前面那道确定性风控闸门。
 *
 * 这一层不调模型，只做两件模型做不了的事：
 *
 *   1. 给策略定边界：开不开、盯哪几个合约、多大杠杆、单笔最多亏多少、一天最多亏多少。
 *   2. 把模型给的方向和价位换成张数 —— 模型永远拿不到「张数」这个字段，它只说
 *      「在 62300 进、止损 61950」，张数由「这一笔最多亏权益的 0.5%」反推出来。
 *
 * 为什么不让模型自己报张数：它看不到账户余额在变，也不知道这个合约的最小下单量，
 * 报出来的数字要么超仓、要么不够一手。张数是算术题，不是判断题；算术题交给代码，
 * 模型只回答它能看见的那部分。
 *
 * 闸门每次都把「凭什么放行 / 凭什么拦下」原样记下来。被拦下的单不是错误，
 * 是这条策略正常工作的一部分 —— 界面上要能看见它拦了什么，否则无从判断策略好不好。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOME_DIR } from './config.js';

/** 策略落在用户目录，和 .env 挨着：换设备、重装都还在，也不会被提交进仓库 */
export const AI_STRATEGY_PATH = join(HOME_DIR, 'ai-strategy.json');

/** 决策深度。quick 一次调用，standard 七次，deep 十几次 —— 档位直接对应模型账单 */
export type Depth = 'quick' | 'standard' | 'deep';

/** 这个周期列表和路由层的 INTERVALS 保持一致：填了别的，K 线那一步就会去问一个不存在的周期 */
const ALLOWED_INTERVALS = new Set(['5m', '15m', '30m', '1h', '4h']);

export interface StrategyConfig {
  /** 总开关。关掉之后一个决定都不做 —— 停不是「只给建议」，是彻底不做 */
  enabled: boolean;
  /**
   * 用哪条策略。
   *
   * 一条策略是在**某一个币种**上训练、回测、判定达标的。拿它在别的币上跑，
   * 等于用一个从未验证过的东西去下单。所以合约池不是自由填的：它跟着策略走。
   *
   * 空串表示还没选策略 —— 这种状态下即使 enabled=true 也不该发单，
   * 因为"没有策略"意味着"没有经过回测的规则"。
   */
  strategyId: string;
  /**
   * 实际要盯的合约池。
   *
   * 由 strategyId 对应的策略推导出来（见 resolveContracts），不从页面直接收。
   * 页面上那一格只读，显示的就是这里。
   */
  contracts: string[];
  interval: string;
  depth: Depth;
  leverage: number;
  marginMode: 'isolated' | 'cross';
  /** 单笔最多亏掉权益的百分之几。张数由它反推 */
  riskPct: number;
  /** 最多同时持有几个 AI 开的仓（不区分合约） */
  maxPositions: number;
  /** 当日亏损到权益的百分之几就熔断，停到第二天 */
  maxDailyLossPct: number;
  /** 模型置信度低于这个值不做 */
  minConfidence: number;
  /** 盈亏比下限：|止盈 - 入场| / |入场 - 止损| */
  minRR: number;
  /** 单笔最多占用可用保证金的百分之几 —— 和单笔风险一起夹，谁小听谁的 */
  maxMarginPct: number;
  /** 同一个合约两次决策之间至少隔多少分钟 */
  cooldownMin: number;
  /** 止损距离下限（ATR 倍数）。比这更近的止损会被一根正常波动扫掉 */
  stopAtrMult: number;
  /**
   * 实盘确认。
   *
   * 模拟盘不需要它；当前环境是实盘时，没有这一条就不发单。
   * 切环境会把它清掉（见路由层），所以「在模拟盘上确认过」不会带到实盘去。
   */
  liveConfirmed: boolean;
  /** 当日亏损基准：哪一天、那天开始时的权益 */
  dayKey: string;
  dayStartEquity: number;
  /** 熔断原因和截止时刻（0 表示没有熔断） */
  haltReason: string;
  haltUntil: number;
}

export const STRATEGY_DEFAULTS: StrategyConfig = {
  enabled: false,
  strategyId: '',
  contracts: [],
  interval: '15m',
  depth: 'standard',
  leverage: 10,
  marginMode: 'isolated',
  riskPct: 0.5,
  maxPositions: 2,
  maxDailyLossPct: 3,
  minConfidence: 0.55,
  minRR: 1.5,
  maxMarginPct: 40,
  cooldownMin: 15,
  stopAtrMult: 0.8,
  liveConfirmed: false,
  dayKey: '',
  dayStartEquity: 0,
  haltReason: '',
  haltUntil: 0,
};

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/** 合约名统一成大写、去重、去掉不认识的写法。空池子等于「什么都不做」，允许但没意义 */
function cleanContracts(v: unknown, fallback: string[]): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/) : null;
  if (!raw) return fallback;
  const out: string[] = [];
  for (const item of raw) {
    const name = String(item ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    // Gate 的永续合约名是 XXX_USDT 这种形状。只写 BTC 的顺手补上，省得人填错
    const full = name.includes('_') ? name : name ? name + '_USDT' : '';
    if (full && !out.includes(full)) out.push(full);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 把外面递进来的东西收敛成一份合法配置。
 *
 * 每一格都有上下限，因为它们是钱：杠杆填 1000、风险填 50% 这类输入不该被「照单全收」，
 * 也不该静默改成默认值 —— 越界就夹到边界，页面拿回来的就是真正在用的那份。
 */
export function sanitizeStrategy(input: unknown, base: StrategyConfig = STRATEGY_DEFAULTS): StrategyConfig {
  const o = (input ?? {}) as Record<string, unknown>;
  const depthRaw = String(o.depth ?? base.depth);
  const depth: Depth = depthRaw === 'quick' || depthRaw === 'deep' ? depthRaw : 'standard';
  const intervalRaw = String(o.interval ?? base.interval);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    strategyId: typeof o.strategyId === 'string' ? o.strategyId.trim() : base.strategyId,
    // 合约池现在可以自由改：策略不再绑死训练币种。
    // 换币意味着"这条结论换了个参照"，页面上会把上次回测的币和现在要跑的币并排显示。
    contracts: o.contracts === undefined ? base.contracts : cleanContracts(o.contracts, base.contracts),
    interval: ALLOWED_INTERVALS.has(intervalRaw) ? intervalRaw : base.interval,
    depth,
    leverage: Math.round(clamp(o.leverage ?? base.leverage, 1, 50, base.leverage)),
    marginMode: o.marginMode === 'cross' ? 'cross' : 'isolated',
    riskPct: Number(clamp(o.riskPct ?? base.riskPct, 0.05, 5, base.riskPct).toFixed(2)),
    maxPositions: Math.round(clamp(o.maxPositions ?? base.maxPositions, 1, 8, base.maxPositions)),
    maxDailyLossPct: Number(clamp(o.maxDailyLossPct ?? base.maxDailyLossPct, 0.5, 50, base.maxDailyLossPct).toFixed(2)),
    minConfidence: Number(clamp(o.minConfidence ?? base.minConfidence, 0.1, 0.99, base.minConfidence).toFixed(2)),
    minRR: Number(clamp(o.minRR ?? base.minRR, 0.5, 10, base.minRR).toFixed(2)),
    maxMarginPct: Math.round(clamp(o.maxMarginPct ?? base.maxMarginPct, 5, 100, base.maxMarginPct)),
    cooldownMin: Math.round(clamp(o.cooldownMin ?? base.cooldownMin, 0, 720, base.cooldownMin)),
    stopAtrMult: Number(clamp(o.stopAtrMult ?? base.stopAtrMult, 0.2, 6, base.stopAtrMult).toFixed(2)),
    liveConfirmed: typeof o.liveConfirmed === 'boolean' ? o.liveConfirmed : base.liveConfirmed,
    dayKey: typeof o.dayKey === 'string' ? o.dayKey : base.dayKey,
    dayStartEquity: Number.isFinite(Number(o.dayStartEquity)) ? Number(o.dayStartEquity) : base.dayStartEquity,
    haltReason: typeof o.haltReason === 'string' ? o.haltReason : base.haltReason,
    haltUntil: Number.isFinite(Number(o.haltUntil)) ? Number(o.haltUntil) : base.haltUntil,
  };
}

export function loadStrategy(): StrategyConfig {
  if (!existsSync(AI_STRATEGY_PATH)) return { ...STRATEGY_DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(AI_STRATEGY_PATH, 'utf8'));
    return sanitizeStrategy(raw);
  } catch {
    // 文件读坏了就当没配过。宁可回到「什么都没开」，也不要拿半份配置去下单
    return { ...STRATEGY_DEFAULTS };
  }
}

export function saveStrategy(cfg: StrategyConfig): StrategyConfig {
  const clean = sanitizeStrategy(cfg);
  mkdirSync(dirname(AI_STRATEGY_PATH), { recursive: true });
  // 先写临时文件再改名：写到一半断电时，留下的要么是旧那份，要么是新那份，
  // 不会是一份读不出来的半个 JSON
  const tmp = AI_STRATEGY_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, AI_STRATEGY_PATH);
  return clean;
}


// ---------- 策略 → 合约池 ----------

/**
 * 一条策略能跑在哪些合约上。
 *
 * 答案是：只能是它自己训练时用的那个币种。
 *
 * 原因很直接：策略是在某个合约的历史数据上搜索参数、跑样本外判定通过的。
 * 换一个币，那条"样本外期望 +0.3%/笔"的结论就不再有任何依据 ——
 * 它测的是 BTC 的走势，不是 ETH 的。把参数搬到别的币上，看起来是在"分散"，
 * 实际是在用没验证过的东西下单。
 *
 * 所以合约池不开放手填：选了哪条策略，池子里就只有那条策略的合约。
 * 想要多币种，就在回测研究台里分别对每个币训练、各自达标，再分别开。
 */
export interface StrategyBinding {
  /** 策略库里的 id */
  id: string;
  /** 策略名，页面显示用 */
  name: string;
  /** 它训练时的合约，就是唯一能跑的合约 */
  contract: string;
  interval: string;
  /** 最近一次回测是否达标；null 表示没跑过 */
  passed: boolean | null;
  /** 没达标时的原因，页面要显示 */
  failed: string[];
  /** 样本量够不够。不够的话 passed 不可信 */
  enoughSample: boolean;
}

/**
 * 把一条已保存的策略收成绑定信息。
 *
 * 这个函数不做 IO —— 由调用方把策略读出来递进来，好在 runner / routes 里都能用，
 * 也方便单独测。
 */
export function bindingOf(saved: {
  id: string;
  name: string;
  contract: string;
  interval: string;
  lastRun: { passed: boolean; failed: string[]; enoughSample: boolean } | null;
} | null): StrategyBinding | null {
  if (!saved) return null;
  return {
    id: saved.id,
    name: saved.name,
    contract: saved.contract,
    interval: saved.interval,
    passed: saved.lastRun ? saved.lastRun.passed : null,
    failed: saved.lastRun ? saved.lastRun.failed : [],
    enoughSample: saved.lastRun ? saved.lastRun.enoughSample : false,
  };
}

/**
 * 决定这次能不能跑。
 *
 * 返回理由，而不是布尔：页面上要能说清"为什么不能开"，
 * 否则用户只能看到一个灰掉的按钮。
 */
export function checkRunnable(cfg: StrategyConfig, binding: StrategyBinding | null): {
  ok: boolean;
  reason: string;
} {
  if (!cfg.strategyId) {
    return { ok: false, reason: '还没选策略。AI 只能按一条回测过的策略下单' };
  }
  if (!binding) {
    return { ok: false, reason: '选中的策略已经不在了（可能被删了），重新选一条' };
  }
  if (binding.passed === null) {
    return {
      ok: false,
      reason: '这条策略还没跑过回测。先到回测研究台按一次回测，看过判定再说',
    };
  }
  if (!binding.enoughSample) {
    return {
      ok: false,
      reason: '这条策略的回测样本不够（样本外交易少于 30 笔），判定不可信，不能拿去下单',
    };
  }
  if (!binding.passed) {
    return {
      ok: false,
      reason: '这条策略上次回测没过：' + (binding.failed.join('、') || '原因不明'),
    };
  }
  return { ok: true, reason: '' };
}

// ---------- 当日亏损 ----------

/** 本地日期，跨天就换 key。用本地时区是因为「今天亏了多少」是给人看的，不是给 UTC 看的 */
export function dayKeyOf(ts = Date.now()): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

/**
 * 记住今天的起始权益。
 *
 * 权益是浮动的：有持仓时它跟着标记价动，没持仓时才等于余额。
 * 所以「今天开始时的权益」只在当天第一次真的拿到账户数据时写一次，之后不再改 ——
 * 每次刷新都重置的话，跌下去的那一段会被抹平成「今天没亏」。
 */
export function noteEquity(cfg: StrategyConfig, total: number): StrategyConfig {
  const day = dayKeyOf();
  if (cfg.dayKey === day && cfg.dayStartEquity > 0) return cfg;
  if (!(total > 0)) return cfg;
  return { ...cfg, dayKey: day, dayStartEquity: total };
}

/** 今天亏了百分之几（正数=亏损）。没有基准时返回 0，不拿 0 当分母 */
export function dayLossPct(cfg: StrategyConfig, total: number): number {
  if (cfg.dayKey !== dayKeyOf() || !(cfg.dayStartEquity > 0) || !(total > 0)) return 0;
  const diff = cfg.dayStartEquity - total;
  return diff > 0 ? (diff / cfg.dayStartEquity) * 100 : 0;
}

// ---------- 风控闸门 ----------

/** 交易所那边这一单要用的参数 */
export interface GateContract {
  multiplier: number;
  sizeMin: number;
  sizeMax: number;
  leverageMax: number;
  takerFee: number;
}

export interface GatePlan {
  action: 'long' | 'short' | 'hold';
  confidence: number;
  entry: number | null;
  stop: number | null;
  target: number | null;
}

export interface GateInput {
  plan: GatePlan;
  /** 最新价和 ATR：现价来自行情，ATR 来自关键位引擎，和界面上那条档位带同源 */
  market: { last: number; atr: number };
  info: GateContract;
  account: { total: number; available: number };
  /** 当前所有持仓条数（不区分是不是 AI 开的） */
  openPositions: number;
  /** 这个合约上有没有仓 —— 有就先不碰，加仓是另一回事，不该由模型顺手决定 */
  contractHasPosition: boolean;
  /** 今天已经亏了百分之几 */
  dayLossPct: number;
}

export interface GateCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface GateOutcome {
  ok: boolean;
  action: 'long' | 'short' | 'hold';
  /** 放行时才有值 */
  size: number;
  notional: number;
  margin: number;
  /** 这一笔到止损位会亏多少钱 */
  riskUsd: number;
  stopDistance: number;
  rr: number;
  /** 张数是被哪一条夹住的：单笔风险还是可用保证金。两个数都要能看见 */
  binding: string;
  checks: GateCheck[];
  /** 拦下的原因（ok=false 时有值，可能多条） */
  refusals: string[];
  warnings: string[];
}

/**
 * 模型的方向 + 三个价位 → 一张能发出去的市价/限价单。
 *
 * 每一条判定都写进 checks：通过的和没通过的都在，界面上按顺序列出来，
 * 这样「为什么没开这一单」不需要靠猜。
 */
export function gatePlan(cfg: StrategyConfig, input: GateInput): GateOutcome {
  const checks: GateCheck[] = [];
  const refusals: string[] = [];
  const warnings: string[] = [];
  const plan = input.plan;
  const last = Number(input.market.last) || 0;
  const atr = Number(input.market.atr) || 0;

  const out: GateOutcome = {
    ok: false,
    action: plan.action,
    size: 0,
    notional: 0,
    margin: 0,
    riskUsd: 0,
    stopDistance: 0,
    rr: 0,
    binding: '',
    checks,
    refusals,
    warnings,
  };

  const add = (label: string, ok: boolean, detail: string) => {
    checks.push({ label, ok, detail });
    if (!ok) refusals.push(label + '：' + detail);
  };

  // 1. 方向
  if (plan.action === 'hold') {
    add('方向', false, '模型判观望，这一轮不做');
    return out;
  }
  add('方向', true, plan.action === 'long' ? '做多' : '做空');

  // 2. 置信度
  add(
    '置信度',
    plan.confidence >= cfg.minConfidence,
    plan.confidence.toFixed(2) + '（门槛 ' + cfg.minConfidence + '）',
  );

  // 3. 现价和 ATR 得是真的
  if (!(last > 0)) add('行情', false, '拿不到最新价，不猜');
  if (!(atr > 0)) add('ATR', false, '引擎没给出 ATR —— ATR 是止损距离的尺子，没有它量不了');

  // 4. 止损必须有，且在正确的一侧
  const entry = plan.entry && plan.entry > 0 ? plan.entry : last;
  const stop = plan.stop ?? 0;
  const target = plan.target ?? 0;
  if (!(stop > 0)) {
    add('止损', false, '模型没给止损价。没有止损的单不开 —— 止损是这一笔唯一能亏的上限');
  } else if (plan.action === 'long' && !(stop < entry)) {
    add('止损', false, '多头止损 ' + stop + ' 不在入场价 ' + entry + ' 下方，挂上去就当场成交');
  } else if (plan.action === 'short' && !(stop > entry)) {
    add('止损', false, '空头止损 ' + stop + ' 不在入场价 ' + entry + ' 上方，挂上去就当场成交');
  } else {
    const dist = Math.abs(entry - stop);
    const distAtr = atr > 0 ? dist / atr : 0;
    out.stopDistance = Number(dist.toPrecision(10));
    if (atr > 0 && distAtr < cfg.stopAtrMult) {
      add('止损距离', false, '只有 ' + distAtr.toFixed(2) + '×ATR，比设定的 ' + cfg.stopAtrMult + '×ATR 更近 —— 一根正常波动就会先把它扫掉');
    } else {
      add('止损距离', true, distAtr.toFixed(2) + '×ATR');
      if (distAtr > 6) warnings.push('止损有 ' + distAtr.toFixed(1) + '×ATR 那么远，张数会被压得很小');
    }
  }

  // 5. 盈亏比
  if (!(target > 0)) {
    add('盈亏比', false, '模型没给止盈价，算不出盈亏比');
  } else if (out.stopDistance > 0) {
    const reward = Math.abs(target - entry);
    out.rr = Number((reward / out.stopDistance).toFixed(2));
    add('盈亏比', out.rr >= cfg.minRR, out.rr.toFixed(2) + '（门槛 ' + cfg.minRR + '）');
  }

  // 6. 这个合约上已经有仓
  if (input.contractHasPosition) {
    add('重复开仓', false, '这个合约上已经有持仓。加仓不该由模型顺手决定，想加自己点');
  }

  // 7. 同时持仓数
  add(
    '持仓数',
    input.openPositions < cfg.maxPositions,
    input.openPositions + ' / ' + cfg.maxPositions,
  );

  // 8. 日内亏损熔断
  add(
    '日内亏损',
    input.dayLossPct < cfg.maxDailyLossPct,
    '今天已亏 ' + input.dayLossPct.toFixed(2) + '%（上限 ' + cfg.maxDailyLossPct + '%）',
  );

  if (refusals.length > 0) return out;

  // ---------- 张数：这一笔最多亏多少，反推能开几张 ----------
  const mult = Number(input.info.multiplier) || 0;
  if (!(mult > 0)) {
    add('合约乘数', false, '拿不到每张多少币，算不出风险');
    return out;
  }

  const equity = Number(input.account.total) || 0;
  const available = Number(input.account.available) || 0;
  if (!(equity > 0)) {
    add('权益', false, '读不到账户权益');
    return out;
  }

  const riskBudget = equity * (cfg.riskPct / 100);
  const riskPerContract = out.stopDistance * mult;
  const sizeByRisk = riskPerContract > 0 ? Math.floor(riskBudget / riskPerContract) : 0;

  // 保证金口径：一手占用 = 名义价值 / 杠杆。这里用现价估，实际以交易所算的为准
  const lev = Math.max(1, Math.min(cfg.leverage, input.info.leverageMax || cfg.leverage));
  if (lev !== cfg.leverage) {
    warnings.push('这个合约最多 ' + input.info.leverageMax + '×，杠杆按 ' + lev + '× 算');
  }
  const marginPerContract = (last * mult) / lev;
  const marginBudget = available * (cfg.maxMarginPct / 100);
  const sizeByMargin = marginPerContract > 0 ? Math.floor(marginBudget / marginPerContract) : 0;

  let size = Math.min(sizeByRisk, sizeByMargin);
  if (input.info.sizeMax > 0) size = Math.min(size, Math.floor(input.info.sizeMax));
  out.binding = sizeByRisk <= sizeByMargin ? '单笔风险' : '可用保证金';

  const minSize = Math.max(1, Math.ceil(input.info.sizeMin || 1));
  add(
    '张数',
    size >= minSize,
    size >= minSize
      ? size + ' 张（被' + out.binding + '夹住：风险侧 ' + sizeByRisk + ' 张 / 保证金侧 ' + sizeByMargin + ' 张）'
      : '按单笔风险只能开 ' + Math.max(0, size) + ' 张，保证金侧 ' + sizeByMargin + ' 张，'
        + '都低于这个合约的最小下单 ' + minSize + ' 张。两条路都堵着：'
        + '「单笔风险 × 权益 ÷（止损距离 × 每张币数）」不够一手，要么放宽 riskPct，'
        + '要么这一笔换成止损更远的形态；保证金侧不够则是可用余额太少',
  );

  if (refusals.length > 0) return out;

  out.ok = true;
  out.action = plan.action;
  out.size = size;
  out.notional = Number((size * mult * last).toFixed(2));
  out.margin = Number(((size * mult * last) / lev).toFixed(2));
  out.riskUsd = Number((size * riskPerContract).toFixed(2));
  return out;
}