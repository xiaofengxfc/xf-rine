
/**
 * 回测引擎。
 *
 * 逐根推进，第 i 根只能看见 0..i 的数据 —— 这不是"尽量别用未来数据"，
 * 而是结构上不给：`view(i)` 返回的切片到 i 为止，引擎内部没有任何地方能拿到 i 之后的 K 线。
 * 未来函数是这类代码最常见的错，靠自觉挡不住，只能靠接口形状挡住。
 *
 * 成交假设写死在下面几处，说清楚比藏着强：
 *   · 信号在第 i 根收盘决定，成交在第 i+1 根开盘。同一根里既看收盘又按收盘成交，等于偷了一个价。
 *   · 每笔进出都按 taker 费率收钱，成交价再加一点滑点。
 *   · 逐仓、按张数算，和这个项目里真实下单的口径一致（每张 quant_multiplier 个币）。
 *   · 止损/止盈用触发单语义：跳空越过触发价时按更差的价成交，不吃到触发价那个"想象中的好价"。
 *   · 资金费率按 8 小时一次的累计值扣，持多付、持空收（费率为正时）。
 */

export interface Candle {
  /** 开盘时间，unix 秒 */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** 策略参数：全部是数字，可搜索的也是它们 */
export type Params = Record<string, number>;

export type StopKind = 'atr' | 'pct';
export type TargetKind = 'atr' | 'pct' | 'rr';

// ---------- 指标引用 ----------
//
// 以前这里是一个扁平的 params，所有指标都从里面找 period。问题很直接：一条策略里
// "快线 EMA(20)" 和 "慢线 EMA(50)" 都是 ema，扁平 params 只能存一个 period，
// 于是搜索改了 slow 而结果一动不动 —— 参数是摆设，回测出来的"最优参数"就没有意义。
//
// 现在每个指标引用自己带一个 periodKey，指向 params 里的键，两个 EMA 各有各的周期。

/** 一个指标实例：指标名 + 周期从 params 的哪个键取 */
export interface IndicatorRef {
  name: string;
  /** 指向 params 里的键。不写就用 `period` */
  periodKey?: string;
}

/**
 * 一条入场条件。
 *
 * `shift` 是把左边往前挪几根再比：shift=1 表示"用上一根的左值"。
 * 这是表达"假突破"这类形态唯一干净的办法：
 *   跌破前低又收回 = 上一根收盘 < 前低（shift=1、op='<'） 且 当根收盘 > 前低
 * 没有 shift 的话，只能写成"收盘 > 前低"，而那个条件几乎永远为真 —— 它描述的不是形态，
 * 是"价格在前低之上"，等于没有条件。
 */
export interface Condition {
  left: IndicatorRef;
  op: '>' | '<' | '>=' | '<=' | 'crossUp' | 'crossDown';
  right: IndicatorRef;
  /** right 是常数时，指向 params 里的哪个键（此时忽略 right.name） */
  rightParam?: string;
  /** 左边取第 i-shift 根的值。0 或不写 = 当前根 */
  shift?: number;
  /** 右边也往前挪几根（比如"当根收盘 vs 上一根的前低"）。不写 = 和左值同一时点 */
  rightShift?: number;
}

export interface StrategySpec {
  name: string;
  /** 做多还是做空。两个方向分开定义，一个策略只做一个方向，免得回测里多空对冲互相抵消 */
  side: 'long' | 'short';
  /** 指标参数，比如 { fast: 12, slow: 26 } */
  params: Params;
  /** 可搜索的参数范围：key -> [最小值, 最大值, 步长] */
  ranges: Record<string, [number, number, number]>;
  entry: Condition[];
  stop: { kind: StopKind; value: number };
  target: { kind: TargetKind; value: number };
  /** 同一时刻最多持几手，1 = 不加仓 */
  maxPositions: number;
}

export interface BacktestOpts {
  /**
   * 外部指标：由调用方算好、引擎直接按名字取。
   *
   * 现在用来喂「最近支撑价 / 最近阻力价」—— 它们来自关键位引擎，不是从 K 线算出来的，
   * 但条件表达式要能像用 EMA、RSI 那样用它们（比如「现价离最近阻力不到 0.5×ATR 就不做多」）。
   * 名字和内置指标共用一套命名空间，撞名以内置的为准。
   */
  /**
   * 签名是 (下标, 这根 K 线)。第二参数不能省：参数搜索会把 K 线切成训练/验证/盲测三段，
   * 段内下标和原始下标对不上，只靠下标取值会整体错位。调用方按 K 线时间查表即可。
   */
  virtual?: Record<string, (i: number, candle: Candle) => number>;
  /**
   * 外部信号：第 i 根收盘后该做多 / 做空 / 不做。
   *
   * 给了这个，引擎就不再算 spec.entry 的条件，方向完全由它决定 ——
   * 提示词策略就是这么接进来的：模型给方向，张数、止损、成交价仍然由引擎算。
   *
   * 方向变化时：和当前持仓反向 → 先平；同向继续持；flat → 平掉。
   * 从"没仓"到"有方向" → 按下一根开盘开仓。
   */
  signalAt?: (i: number) => 'long' | 'short' | 'flat';
  /** 首个允许开仓的信号下标。此前 K 线只用于指标预热。 */
  tradeStartIndex?: number;
  /** 每个合约的乘数：1 张 = multiplier 个币 */
  multiplier: number;
  /** taker 费率，比如 0.0005 */
  feeRate: number;
  /** 滑点，按价格的百分比，比如 0.0002 */
  slippagePct: number;
  /** 初始保证金（USDT）。按张数下注，所以要换算成本金 */
  capital: number;
  /** 止损触发时承担的权益比例，例如 0.005 表示 0.5%。 */
  riskPerTrade: number;
  /** 保证金最多占当前权益的比例，默认 40%，与实盘风控一致。 */
  maxMarginPct?: number;
  /** 可选的交易所张数步进及上下限。 */
  sizeStep?: number;
  sizeMin?: number;
  sizeMax?: number;
  leverage: number;
  /** 可选的合约杠杆上限。 */
  leverageMax?: number;
  /** 资金费率（8 小时一次），按 K 线时间线性摊到每根 */
  fundingRatePer8h: number;
}

export interface Trade {
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  size: number;
  /** 毛盈亏（USDT），已含滑点，未含手续费 */
  gross: number;
  fee: number;
  funding: number;
  /** 净盈亏 = gross - fee - funding */
  net: number;
  /** 出场方式 */
  reason: 'stop' | 'target' | 'signal' | 'end';
  /** 这一笔的盈亏比：盈利 / 亏损的绝对值，亏损时是负数 */
  rr: number;
}

export interface BacktestResult {
  trades: Trade[];
  /** 每根收盘后的权益，用来算回撤 */
  equity: { t: number; v: number }[];
  stats: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    /** 平均盈利 / 平均亏损的绝对值 —— 这才是"盈亏比" */
    payoff: number;
    /** 每笔期望（USDT） */
    expectancy: number;
    /** 每笔期望占初始本金的百分比 */
    expectancyPct: number;
    totalReturnPct: number;
    maxDrawdownPct: number;
    profitFactor: number;
    /** 连续亏损的最大笔数 */
    maxLosingStreak: number;
    totalFee: number;
    totalFunding: number;
    avgHoldBars: number;
  };
}

/** 一张开着的仓。引擎内部用，不对外 */
export interface OpenPosition {
  /** 这一笔是多还是空。规则策略恒等于 spec.side；外部信号模式下会变 */
  side: 'long' | 'short';
  entryIndex: number;
  entryPrice: number;
  size: number;
  stop: number;
  target: number;
  margin: number;
  fundingPaid: number;
}

/** 指标在某个下标的值。实现见 indicators.ts */
export interface IndicatorSeries {
  /** 返回第 i 根的值；数据不足时返回 NaN */
  at(i: number): number;
}

/**
 * 指标工厂。
 *
 * 引擎只认这个接口，不认具体是 EMA 还是 RSI —— 加指标不用改引擎。
 * 缓存在这里做：同名的指标只算一次，条件是 AND，几个条件常常共用同一个指标。
 */
export class IndicatorCache {
  private candles: Candle[];
  private series = new Map<string, IndicatorSeries>();
  private virtual: Record<string, (i: number, candle: Candle) => number>;

  constructor(candles: Candle[], virtual: Record<string, (i: number, candle: Candle) => number> = {}) {
    this.candles = candles;
    this.virtual = virtual;
  }

  /** 按引用取指标：周期从 params[periodKey] 里读，不同实例互不干扰 */
  get(ref: IndicatorRef, params: Params): IndicatorSeries {
    // 外部指标优先：它由调用方算好，没有"周期"这个概念
    const virt = this.virtual[ref.name];
    if (virt) {
      return {
        at: (i: number) => {
          const c = this.candles[i];
          return c ? virt(i, c) : NaN;
        },
      };
    }

    const periodKey = ref.periodKey ?? 'period';
    const local: Params = { ...params };
    // 把"这个实例的周期"放到标准键上，indicators.ts 那层不用知道调用方怎么命名的
    const resolved = params[periodKey] ?? params.period ?? 20;
    local.period = resolved;
    if (ref.name === 'atr') local.atrPeriod = params[ref.periodKey ?? 'atrPeriod'] ?? params.atrPeriod ?? resolved;
    const key = ref.name + '|' + JSON.stringify(local);
    let hit = this.series.get(key);
    if (!hit) {
      hit = buildIndicator(ref.name, this.candles, local);
      this.series.set(key, hit);
    }
    return hit;
  }
}

// 具体实现从 indicators.ts 注入，避免这个文件同时管"怎么回测"和"指标怎么算"
import { buildIndicator as buildIndicatorImpl } from './indicators.js';
import { ceilSizeToStep, floorSizeToStep } from '../exchange/size.js';
function buildIndicator(name: string, candles: Candle[], params: Params): IndicatorSeries {
  return buildIndicatorImpl(name, candles, params);
}

/** 判断一个条件在第 i 根成不成立 */
export function conditionHolds(c: Condition, i: number, cache: IndicatorCache, params: Params): boolean {
  // shift：左边往前挪几根。两边可以各自错开，这样"上一根收盘"和"当根的前低"能同台比较
  const ls = Math.max(0, Math.round(c.shift ?? 0));
  const rs = Math.max(0, Math.round(c.rightShift ?? 0));
  const left = cache.get(c.left, params).at(i - ls);
  if (!Number.isFinite(left)) return false;
  const right = c.rightParam
    ? (params[c.rightParam] ?? NaN)
    : cache.get(c.right, params).at(i - rs);
  if (!Number.isFinite(right)) return false;

  switch (c.op) {
    case '>': return left > right;
    case '<': return left < right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    case 'crossUp': {
      // 上一根还不满足、这一根满足，才算"上穿"。少了"上一根不满足"这一半，
      // 一路在上面的指标会每根都报一次穿越
      const lPrev = cache.get(c.left, params).at(i - ls - 1);
      const rPrev = c.rightParam ? right : cache.get(c.right, params).at(i - rs - 1);
      return Number.isFinite(lPrev) && Number.isFinite(rPrev) && lPrev <= rPrev && left > right;
    }
    case 'crossDown': {
      const lPrev = cache.get(c.left, params).at(i - ls - 1);
      const rPrev = c.rightParam ? right : cache.get(c.right, params).at(i - rs - 1);
      return Number.isFinite(lPrev) && Number.isFinite(rPrev) && lPrev >= rPrev && left < right;
    }
    default:
      return false;
  }
}

/**
 * 指标预热需要多少根才出第一个有效值。
 *
 * 这里**不加一**：`warmupFor` 给的是"第几根开始有值"的下标，引擎本来就按
 * `i >= warmup` 判断。以前在这里多加了 1，结果每一根真实有值的都被当成还在预热，
 * 数据短的回测一笔都开不出来 —— 这个错只有在"以为引擎没问题、是测试写错了"反复
 * 排查的最后一刻才暴露，所以写成注释留着。
 *
 * 只有上穿/下穿这种需要"上一根也有效"的条件，才额外要一根。
 */
export function warmupOf(spec: StrategySpec): number {
  let need = 0;
  let needPrevBar = false;
  /** 外部指标（关键位那种）自带时间线，不需要按 K 线预热 */
  const isVirtual = (n: string) => n === 'zoneSupport' || n === 'zoneResistance';
  for (const c of spec.entry) {
    for (const ref of [c.left, c.right]) {
      if (isVirtual(ref.name)) continue;
      const resolved = spec.params[ref.periodKey ?? 'period'] ?? spec.params.period ?? 20;
      const local: Params = { ...spec.params, period: resolved };
      if (ref.name === 'atr') local.atrPeriod = spec.params[ref.periodKey ?? 'atrPeriod'] ?? spec.params.atrPeriod ?? resolved;
      const w = warmupForIndicator(ref.name, local);
      if (w > need) need = w;
    }
    // 上穿/下穿要上一根；shift/rightShift 还要再多几根
    if (c.op === 'crossUp' || c.op === 'crossDown') needPrevBar = true;
    need = Math.max(need, 0);
    const extra = Math.max(1, (c.shift ?? 0) + (c.rightShift ?? 0) + 1);
    if (extra > 1) need = Math.max(need, need + extra - 1);
  }
  // 止损止盈用 ATR 时，ATR 也得预热
  need = Math.max(need, warmupForIndicator('atr', { atrPeriod: spec.params.atrPeriod ?? 14 }));
  return needPrevBar ? need + 1 : need;
}

import { warmupFor as warmupForIndicator } from './indicators.js';

/**
 * 跑一次回测。
 *
 * !!! 这里就是"不许看未来"的那道墙 !!!
 * 循环体只碰 candles[i]，从不碰 i+1 之后的东西；成交用的是下一根的开盘价，那是在
 * 信号已经确定之后才被读取的。要加新逻辑，先问一句：它需要第 i 根之后的数据吗？
 */
export function backtest(spec: StrategySpec, candles: Candle[], opts: BacktestOpts): BacktestResult {
  const cache = new IndicatorCache(candles, opts.virtual);
  const warmup = warmupOf(spec);
  const trades: Trade[] = [];
  const equity: { t: number; v: number }[] = [];

  /**  /**
   * 持仓状态。
   *
   * "有没有持仓"和"持仓是什么"拆成两个变量，而不是一个联合类型。
   *
   * 这不是风格选择：open()/close() 是闭包，它们会改持仓；TS 的控制流分析会把
   * "循环末尾调用过 open()，于是下一轮开头 pos 一定是 Flat" 这个推断带进下一轮，
   * 结果循环体里所有字段访问都报「Flat 上没有 size」，换着法绕都会换个位置继续报。
   * 用一个独立的 boolean 承载"有没有"，收窄就只发生在 boolean 上，读字段时显式取
   * 快照并标注类型，和闭包怎么改状态就彻底无关了。
   */
  let holding = false;
  let pos: OpenPosition = {
    side: spec.side,
    entryIndex: 0, entryPrice: 0, size: 0, stop: 0, target: 0, margin: 0, fundingPaid: 0,
  };

  let balance = opts.capital;
  const tradeStartIndex = Math.max(warmup, Math.ceil(opts.tradeStartIndex ?? 0));
  const maxMarginPct = Number.isFinite(opts.maxMarginPct)
    ? Math.max(0, Math.min(1, opts.maxMarginPct!))
    : 0.4;
  // 每根的资金费率：8 小时一次，按这根 K 线覆盖的秒数摊
  const barSeconds = candles.length > 1 ? candles[1]!.t - candles[0]!.t : 0;
  const fundingPerBar = barSeconds > 0 ? opts.fundingRatePer8h * (barSeconds / (8 * 3600)) : 0;
  const slip = opts.slippagePct;

  /** 按方向算一笔的净盈亏（已扣滑点，未扣手续费和资金费） */
  const pnl = (side: 'long' | 'short', entry: number, exit: number, size: number): number => {
    const diff = side === 'long' ? exit - entry : entry - exit;
    return diff * size * opts.multiplier;
  };

  /**
   * 以某个价格开仓。返回有没有开成。
   *
   * dir 不传就按 spec.side —— 规则策略永远只有一个方向；
   * 提示词策略每一轮可能换边，由 signalAt 决定。
   */
  const open = (signalIndex: number, entryIndex: number, price: number, dir: 'long' | 'short' = spec.side): boolean => {
    if (holding) return false;
    const entryPrice = dir === 'long' ? price * (1 + slip) : price * (1 - slip);
    // 信号在前一根收盘后确定。下一根开盘成交时只能使用信号 K 线的 ATR，
    // 不能用入场 K 线之后才知道的高低收价设定止损止盈。
    const atr = cache.get({ name: 'atr', periodKey: 'atrPeriod' }, spec.params).at(signalIndex);
    const stopDist = stopDistance(spec, entryPrice, atr);
    const targetDist = targetDistance(spec, entryPrice, atr, stopDist);
    if (!(stopDist > 0) || !(targetDist > 0)) return false;

    const riskPerContract = stopDist * opts.multiplier;
    const leverageCap = opts.leverageMax && opts.leverageMax > 0 ? opts.leverageMax : opts.leverage;
    const leverage = Math.max(1, Math.min(opts.leverage, leverageCap));
    const marginPerContract = (price * opts.multiplier) / leverage;
    if (!(riskPerContract > 0) || !(marginPerContract > 0)) return false;
    const riskBudget = balance * opts.riskPerTrade;
    const marginBudget = balance * maxMarginPct;
    const sizeStep = opts.sizeStep && opts.sizeStep > 0 ? opts.sizeStep : 1;
    const sizeByRisk = floorSizeToStep(riskBudget / riskPerContract, sizeStep);
    const sizeByMargin = floorSizeToStep(marginBudget / marginPerContract, sizeStep);
    let size = Math.min(sizeByRisk, sizeByMargin);
    if (opts.sizeMax && opts.sizeMax > 0) {
      size = Math.min(size, floorSizeToStep(opts.sizeMax, sizeStep));
    }
    const minSize = ceilSizeToStep(opts.sizeMin && opts.sizeMin > 0 ? opts.sizeMin : sizeStep, sizeStep);
    if (size < minSize) return false;

    pos = {
      side: dir,
      entryIndex,
      entryPrice,
      size,
      stop: dir === 'long' ? entryPrice - stopDist : entryPrice + stopDist,
      target: dir === 'long' ? entryPrice + targetDist : entryPrice - targetDist,
      margin: size * marginPerContract,
      fundingPaid: 0,
    };
    holding = true;
    return true;
  };

  /** 以某个价格平仓，并记账 */
  const close = (i: number, price: number, reason: Trade['reason']): void => {
    if (!holding) return;
    const p: OpenPosition = { ...pos };
    // 用持仓自己的方向，不用 spec.side：提示词策略可能这轮做空
    const exitPrice = p.side === 'long' ? price * (1 - slip) : price * (1 + slip);
    const gross = pnl(p.side, p.entryPrice, exitPrice, p.size);
    const notionalIn = p.entryPrice * p.size * opts.multiplier;
    const notionalOut = exitPrice * p.size * opts.multiplier;
    const fee = (notionalIn + notionalOut) * opts.feeRate;
    const net = gross - fee - p.fundingPaid;
    // 盈亏比：按"到止损会亏多少"当分母，胜了是正数、亏了是负数
    const risk = Math.abs(p.entryPrice - p.stop) * p.size * opts.multiplier;
    const rr = risk > 0 ? gross / risk : 0;

    trades.push({
      side: p.side,
      entryTime: candles[p.entryIndex]!.t,
      entryPrice: p.entryPrice,
      exitTime: candles[i]!.t,
      exitPrice,
      size: p.size,
      gross,
      fee,
      funding: p.fundingPaid,
      net,
      reason,
      rr,
    });
    balance += net;
    holding = false;
  };

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]!;

    // ---- 持仓中：先看这一根有没有触发止损/止盈 ----
    if (holding) {
      const held: OpenPosition = pos;

      // 资金费先扣：这根 K 线跨过了几个 8 小时结算点就扣几次
      if (fundingPerBar !== 0) {
        const cost = bar.c * held.size * opts.multiplier * fundingPerBar * (held.side === 'long' ? 1 : -1);
        // 正费率时多头付钱（净收支为负），空头收钱。cost 带符号直接进账
        held.fundingPaid += -cost;
      }

      // 同一根里止损和止盈都够得着时，按"先扫止损"算 —— 只有这一根的 OHLC，
      // 分不出谁先到；往坏处假设，免得回测比实盘好看
      const hitStop = held.side === 'long' ? bar.l <= held.stop : bar.h >= held.stop;
      const hitTarget = held.side === 'long' ? bar.h >= held.target : bar.l <= held.target;
      if (hitStop) {
        // 跳空：开盘就已经越过止损时，按开盘价成交，按触发价成交是作弊
        const stopPrice = held.stop;
        const trigger = held.side === 'long'
          ? (bar.o <= stopPrice ? bar.o : stopPrice)
          : (bar.o >= stopPrice ? bar.o : stopPrice);
        close(i, trigger, 'stop');
      } else if (hitTarget) {
        const targetPrice = held.target;
        const trigger = held.side === 'long'
          ? (bar.o >= targetPrice ? bar.o : targetPrice)
          : (bar.o <= targetPrice ? bar.o : targetPrice);
        close(i, trigger, 'target');
      }
    }

    // 先记录刚收盘 K 线的权益，再处理下一根开盘成交的信号单，
    // 避免把新仓错记到信号 K 线的收盘权益上。
    const unrealised = holding
      ? pnl(pos.side, pos.entryPrice, bar.c, pos.size) - pos.fundingPaid
      : 0;
    equity.push({ t: bar.t, v: balance + unrealised });

    // ---- 收盘后判断信号，成交放到下一根开盘 ----
    if (i < candles.length - 1) {
      const next = candles[i + 1]!;

      if (opts.signalAt) {
        /**
         * 外部信号模式：方向由回调给，规则条件不参与。
         *
         * 这里必须重新算一个"这一根该拿哪边"，而不是复用 spec.side ——
         * 提示词策略可以这一轮做多、下一轮做空，spec.side 只是它初始声明。
         */
        const want = opts.signalAt(i);
        if (holding) {
          if (want === 'flat' || want !== pos.side) close(i + 1, next.o, 'signal');
        }
        if (!holding && want !== 'flat' && i >= tradeStartIndex) open(i, i + 1, next.o, want);
      } else {
        if (holding) {
          // 反向信号平仓：只在明确的穿越信号上平，不在每个不满足的根上平 ——
          // 后者会因为条件短暂失效把仓平在噪音里
          const crossed = spec.side === 'long'
            ? spec.entry.some((c) => c.op === 'crossDown' && conditionHolds(c, i, cache, spec.params))
            : spec.entry.some((c) => c.op === 'crossUp' && conditionHolds(c, i, cache, spec.params));
          if (crossed) close(i + 1, next.o, 'signal');
        }
        if (!holding && i >= tradeStartIndex) {
          const ok = spec.entry.every((c) => conditionHolds(c, i, cache, spec.params));
          if (ok) open(i, i + 1, next.o);
        }
      }
    }

  }

  // 最后一根还没平：按收盘平掉，让这笔进统计。不平的话最后一笔永远悬着，统计少一笔
  if (holding) {
    close(candles.length - 1, candles[candles.length - 1]!.c, 'end');
    // 最后一根权益先于退出滑点和手续费记账。这里用平仓后的余额更新，
    // 让收益、回撤与已平仓交易的净值一致。
    equity[equity.length - 1]!.v = balance;
  }

  return { trades, equity, stats: statsOf(trades, equity, opts.capital) };
}

function stopDistance(spec: StrategySpec, entry: number, atr: number): number {
  if (spec.stop.kind === 'pct') return entry * spec.stop.value;
  return atr * spec.stop.value;
}

function targetDistance(spec: StrategySpec, entry: number, atr: number, stopDist: number): number {
  if (spec.target.kind === 'pct') return entry * spec.target.value;
  if (spec.target.kind === 'rr') return stopDist * spec.target.value;
  return atr * spec.target.value;
}

function statsOf(trades: Trade[], equity: { t: number; v: number }[], capital: number): BacktestResult['stats'] {
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const grossWin = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const last = equity.length ? equity[equity.length - 1]!.v : capital;

  // 最大回撤按权益曲线的高水位算
  let peak = capital;
  let maxDd = 0;
  for (const point of equity) {
    if (point.v > peak) peak = point.v;
    const dd = peak > 0 ? (peak - point.v) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  // 最长连亏
  let streak = 0;
  let maxStreak = 0;
  for (const t of trades) {
    if (t.net <= 0) { streak += 1; if (streak > maxStreak) maxStreak = streak; } else streak = 0;
  }

  const n = trades.length;
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n : 0,
    payoff: losses.length && grossLoss > 0 ? (wins.length ? grossWin / wins.length : 0) / (grossLoss / losses.length) : 0,
    expectancy: n ? trades.reduce((s, t) => s + t.net, 0) / n : 0,
    expectancyPct: n ? (trades.reduce((s, t) => s + t.net, 0) / n / capital) * 100 : 0,
    totalReturnPct: capital > 0 ? ((last - capital) / capital) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    maxLosingStreak: maxStreak,
    totalFee: trades.reduce((s, t) => s + t.fee, 0),
    totalFunding: trades.reduce((s, t) => s + t.funding, 0),
    avgHoldBars: n ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / n : 0,
  };
}
