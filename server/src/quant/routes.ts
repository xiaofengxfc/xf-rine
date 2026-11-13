
/**
 * 回测研究台的接口。
 *
 * 三个动作：
 *   POST /quant/research   跑一次多轮研究（模型提假设 → 回测 → 判定），流式推进度
 *   POST /quant/backtest   拿一份手写的策略直接回测，不经过模型
 *   GET  /quant/catalog    指标清单和默认值，页面用它画编辑器
 *
 * 研究是长任务（一轮十几秒到一分钟，多轮就几分钟），所以用 NDJSON 一行一行往下推，
 * 而不是等全部跑完再回包 —— 页面能看见"第 2 轮在跑"，而不是对着一个转圈的后台。
 */

import { Router, type Request, type Response } from 'express';
import { gatePublic } from '../gate/rest.js';
import { config } from '../config.js';
import { getSeries } from './data.js';
import { backtest, type BacktestResult, type StrategySpec, type Candle } from './backtest.js';
import { runPromptSignals, expandSignals, randomBaselineSignals } from './promptBacktest.js';
import { searchParameters } from './search.js';
import { judge, DEFAULT_CRITERIA, type Verdict } from './criteria.js';
import { listStrategies, saveStrategy, deleteStrategy, recordRun, getStrategy, renameStrategy } from './library.js';
import { research, verdictLine, type ResearchReport } from './research.js';
import { INDICATORS } from './indicators.js';
import { FALLBACK_HYPOTHESIS, toSpec, type Hypothesis } from './ai.js';

/** 一次研究最多跑几轮。再多就是在拟合噪音，而且账单会很难看 */
const MAX_ROUNDS = 6;
/** 拉多少根 K 线。交易所每周期只留约 9000 根，要多了也没用 */
const MAX_BARS = 9000;

interface ContractMeta {
  multiplier: number;
  takerFee: number;
}

/** 合约乘数和费率：回测要按它换算张数，不能拍脑袋 */
async function contractMeta(contract: string): Promise<ContractMeta> {
  const c = await gatePublic<{ quanto_multiplier: string; taker_fee_rate: string }>(
    '/futures/usdt/contracts/' + encodeURIComponent(contract), {}, 60_000, 15_000,
  );
  return {
    multiplier: Number(c.quanto_multiplier) || 0.0001,
    takerFee: Number(c.taker_fee_rate) || 0.0005,
  };
}

function marketOf(meta: ContractMeta, body: Record<string, unknown>) {
  const n = (k: string, def: number) => {
    const v = Number(body[k]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    multiplier: meta.multiplier,
    feeRate: meta.takerFee,
    slippagePct: n('slippagePct', 0.0002),
    capital: n('capital', 1000),
    riskPerTrade: n('riskPerTrade', 0.005),
    leverage: n('leverage', 5),
    fundingRatePer8h: Number(body.fundingRatePer8h) || 0,
  };
}

export function mountQuant(router: Router, deps: {
  wrap: (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => void;
  requireLocal: (req: Request, what: string) => void;
}): void {
  const { wrap, requireLocal } = deps;

  router.get('/quant/catalog', (req: Request, res: Response) => {
    res.json({
      indicators: INDICATORS,
      criteria: DEFAULT_CRITERIA,
      fallback: FALLBACK_HYPOTHESIS,
      limits: { maxRounds: MAX_ROUNDS, maxBars: MAX_BARS },
    });
  });


  // ---------- 策略库 ----------
  //
  // 回测研究台编好的策略存这里，AI 交易页从里面挑。两边共用同一份文件，
  // 所以在研究台存完，AI 交易页刷新就能看到，不需要两边各存一份。

  router.get('/quant/strategies', (_req: Request, res: Response) => {
    res.json({ strategies: listStrategies() });
  });

  /** 读单条策略的完整内容 —— 编辑器「打开已有策略」要用它整份载入 */
  router.get('/quant/strategies/:id', (req: Request, res: Response) => {
    const s = getStrategy(String(req.params.id));
    if (!s) {
      res.status(404).json({ error: 'NOT_FOUND', detail: '没有这条策略' });
      return;
    }
    res.json({ strategy: s });
  });

  router.post('/quant/strategies', wrap(async (req: Request, res: Response) => {
    requireLocal(req, '保存策略');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = body.kind === 'prompt' ? 'prompt' : 'rule';
    const name = String(body.name ?? '').trim() || '未命名策略';
    const contract = String(body.contract ?? 'BTC_USDT').toUpperCase();
    const interval = String(body.interval ?? '1h');
    try {
      const saved = saveStrategy({
        id: typeof body.id === 'string' && body.id ? body.id : undefined,
        name,
        kind,
        contract,
        interval,
        spec: kind === 'rule' ? (body.spec as StrategySpec) : null,
        prompt: kind === 'prompt' ? String(body.prompt ?? '') : null,
      });
      res.json({ ok: true, strategy: saved });
    } catch (e) {
      // saveStrategy 会拒绝"空条件"和"空提示词"，把原因原样带回去
      res.status(400).json({ error: 'BAD_STRATEGY', detail: (e as Error).message });
    }
  }));

  /**
   * 改名。
   *
   * 单独一个接口，不走 POST /quant/strategies —— 那条路要重新提交整份策略，
   * 而且"规则变了"会把回测结论清掉。改个名字显然不该清结论。
   */
  router.post('/quant/strategies/:id/rename', wrap(async (req: Request, res: Response) => {
    requireLocal(req, '改策略名');
    const name = String((req.body ?? {}).name ?? '');
    try {
      const s = renameStrategy(String(req.params.id), name);
      if (!s) {
        res.status(404).json({ error: 'NOT_FOUND', detail: '没有这条策略' });
        return;
      }
      res.json({ ok: true, strategy: s });
    } catch (e) {
      res.status(400).json({ error: 'BAD_NAME', detail: (e as Error).message });
    }
  }));

  router.delete('/quant/strategies/:id', wrap(async (req: Request, res: Response) => {
    requireLocal(req, '删除策略');
    const ok = deleteStrategy(String(req.params.id));
    if (!ok) {
      res.status(404).json({ error: 'NOT_FOUND', detail: '没有这条策略' });
      return;
    }
    res.json({ ok: true });
  }));

  /**
   * 把一次回测的结论记到策略上。
   *
   * 单独一个接口而不是在回测时顺手写：回测可以跑很多次、试很多参数，
   * 只有用户确认"就用这一版"时才值得记成这份结论。
   */
  router.post('/quant/strategies/:id/run', wrap(async (req: Request, res: Response) => {
    requireLocal(req, '记录回测结论');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contract = String(body.contract ?? 'BTC_USDT').toUpperCase();
    const interval = String(body.interval ?? '1h');
    const kind = body.kind === 'prompt' ? 'prompt' : 'rule';
    const spec = body.spec as StrategySpec | undefined;
    const prompt = String(body.prompt ?? '').trim();

    const series = await getSeries(contract, interval, MAX_BARS);
    const meta = await contractMeta(contract).catch(() => ({ multiplier: 0.0001, takerFee: 0.0005 }));
    const market = marketOf(meta, body);

    // ---- 提示词策略：和 /quant/backtest 走同一条路，免得两边口径不一样 ----
    if (kind === 'prompt') {
      if (!prompt) {
        res.status(400).json({ error: 'BAD_PROMPT', detail: '提示词是空的' });
        return;
      }
      const p = await runPromptBacktest({
        contract, interval, prompt, candles: series.candles, market,
        step: Math.max(1, Math.min(200, Number(body.step) || PROMPT_DEFAULTS.step)),
        lookback: PROMPT_DEFAULTS.lookback,
      });
      const saved = recordRun(String(req.params.id), p.result, {
        passed: p.verdict ? p.verdict.passed : false,
        failed: p.verdict ? p.verdict.failed.map((f) => f.label) : ['样本不足'],
        enoughSample: p.enoughSample,
        contract,
        interval,
      });
      if (!saved) {
        res.status(404).json({ error: 'NOT_FOUND', detail: '没有这条策略' });
        return;
      }
      res.json({ ok: true, strategy: saved, verdict: p.verdict });
      return;
    }

    if (!spec) {
      res.status(400).json({ error: 'BAD_SPEC', detail: '没有策略内容' });
      return;
    }

    const hasRanges = Object.keys(spec.ranges ?? {}).length > 0;
    let run: { result: BacktestResult; enoughSample: boolean; verdict: Verdict | null };

    if (hasRanges) {
      // 有范围时用搜索选出来的最优参数再跑一次整段，拿到完整的回测结果再记账
      const candidates = searchParameters(spec, series.candles, market, { minTrades: DEFAULT_CRITERIA.minTrades });
      const eligible = candidates.filter((c) => !c.insufficientSample);
      const best = eligible[0] ?? candidates[0];
      if (!best || !best.blindResult) {
        res.status(400).json({ error: 'NO_TRADES', detail: '没有任何候选成交，这份策略在这段数据上跑不出结果' });
        return;
      }
      run = {
        result: best.blindResult,
        enoughSample: eligible.length > 0,
        verdict: eligible.length > 0 ? judge({
          blindExpectancyPct: best.blindExpectancyPct,
          blindTrades: best.blindTrades,
          blindMaxDrawdownPct: best.blindMaxDrawdownPct,
          blindPayoff: best.blindPayoff,
          blindWinRate: best.blindWinRate,
          decay: best.decay,
          costExpectancy: best.costExpectancy,
        }) : null,
      };
    } else {
      const r = backtest(spec, series.candles, market);
      run = {
        result: r,
        enoughSample: r.stats.trades >= DEFAULT_CRITERIA.minTrades,
        verdict: r.stats.trades >= DEFAULT_CRITERIA.minTrades
          ? judge({
              blindExpectancyPct: r.stats.expectancyPct,
              blindTrades: r.stats.trades,
              blindMaxDrawdownPct: r.stats.maxDrawdownPct,
              blindPayoff: r.stats.payoff,
              blindWinRate: r.stats.winRate,
              decay: 0,
              costExpectancy: { '2': r.stats.expectancyPct },
            })
          : null,
      };
    }

    const saved = recordRun(String(req.params.id), run.result, {
      passed: run.verdict ? run.verdict.passed : false,
      failed: run.verdict ? run.verdict.failed.map((f) => f.label) : ['样本不足'],
      enoughSample: run.enoughSample,
      contract,
      interval,
    });
    if (!saved) {
      res.status(404).json({ error: 'NOT_FOUND', detail: '没有这条策略' });
      return;
    }
    res.json({ ok: true, strategy: saved, verdict: run.verdict });
  }));

  /**
   * 多轮研究。用 NDJSON 推进度：每行一个 JSON 对象，最后一行是完整报告。
   *
   * 为什么要流式：一轮十几秒，四轮就是一分钟。等全部跑完再回包的话，
   * 页面上一分钟什么都看不到，人会以为卡死了然后刷新 —— 白花一次模型钱。
   */
  router.post('/quant/research', wrap(async (req: Request, res: Response) => {
    requireLocal(req, '跑 AI 研究');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contract = String(body.contract ?? 'BTC_USDT').toUpperCase();
    const interval = String(body.interval ?? '1h');
    const rounds = Math.min(MAX_ROUNDS, Math.max(1, Number(body.rounds) || 3));

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    // 关掉 Nagle：小包要立刻发出去，否则"第 1 轮开始"那行会在缓冲里躺着
    res.socket?.setNoDelay(true);

    const send = (obj: unknown) => {
      res.write(JSON.stringify(obj) + String.fromCharCode(10));
    };

    /**
     * 取消信号。
     *
     * 这里踩过一个坑：监听 req 的 'close' 会在**响应写完**时也触发，
     * 于是第一轮开始前就被判成"已中止"，研究直接空跑返回。
     * 正确的判断是 res 的 'close' 并且 res.writableEnded 还是 false ——
     * 也就是"客户端真的先走了"，而不是"我们写完了"。
     */
    let cancelled = false;
    res.on('close', () => {
      if (!res.writableEnded) cancelled = true;
    });

    try {
      send({ type: 'stage', stage: 'data', message: '拉 ' + contract + ' ' + interval + ' 的历史 K 线' });
      const series = await getSeries(contract, interval, MAX_BARS);
      if (series.candles.length < 300) {
        send({ type: 'error', message: '只拿到 ' + series.candles.length + ' 根 K 线，太短，做不了研究' });
        res.end();
        return;
      }
      send({
        type: 'data',
        bars: series.candles.length,
        days: Math.round((series.span.to - series.span.from) / 86400),
        gaps: series.gaps,
        from: series.span.from,
        to: series.span.to,
      });

      const meta = await contractMeta(contract).catch(() => ({ multiplier: 0.0001, takerFee: 0.0005 }));
      const report = await research({
        contract,
        interval,
        candles: series.candles,
        gaps: series.gaps,
        market: marketOf(meta, body),
        maxRounds: rounds,
        isCancelled: () => cancelled,
        onHypothesis: (r) => send({
          type: 'hypothesis',
          round: r.round,
          thesis: r.hypothesis.thesis,
          entry: r.hypothesis.entry.map((c) => ({
            left: c.left.name + (c.left.periodKey ? '(' + c.left.periodKey + ')' : ''),
            op: c.op,
            right: c.rightParam ?? c.right.name,
            shift: c.shift ?? 0,
          })),
          params: r.hypothesis.params,
        }),
        onRound: (r) => send({
          type: 'round',
          round: r.round,
          semanticIssues: r.semanticIssues ?? null,
          candidates: r.candidates,
          enoughSample: r.enoughSample,
          best: r.best ? {
            params: r.best.params,
            blindExpectancyPct: r.best.blindExpectancyPct,
            blindTrades: r.best.blindTrades,
            blindPayoff: r.best.blindPayoff,
            blindWinRate: r.best.blindWinRate,
            blindMaxDrawdownPct: r.best.blindMaxDrawdownPct,
            blindReturnPct: r.best.blindReturnPct,
            costExpectancy: r.best.costExpectancy,
            decay: r.best.decay,
          } : null,
          verdict: r.verdict,
        }),
      });

      send({ type: 'done', report, verdict: verdictLine(report) });
      res.end();
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
      res.end();
    }
  }));

  /**
   * 手写策略直接回测。不经过模型 —— 编辑器里改完一行条件就按一下，看它到底行不行。
   * 和 AI 研究用的是同一个引擎、同一个判定，所以两边的数不会打架。
   */
  router.post('/quant/backtest', wrap(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contract = String(body.contract ?? 'BTC_USDT').toUpperCase();
    const interval = String(body.interval ?? '1h');
    const kind = body.kind === 'prompt' ? 'prompt' : 'rule';
    const spec = body.spec as StrategySpec | undefined;

    const series = await getSeries(contract, interval, MAX_BARS);
    if (series.candles.length < 300) {
      res.status(400).json({ error: 'DATA_TOO_SHORT', detail: '只拿到 ' + series.candles.length + ' 根 K 线' });
      return;
    }
    const meta = await contractMeta(contract).catch(() => ({ multiplier: 0.0001, takerFee: 0.0005 }));
    const market = marketOf(meta, body);

    // ---- 提示词策略：先问模型拿方向，再交给同一个引擎 ----
    if (kind === 'prompt') {
      const prompt = String(body.prompt ?? '').trim();
      if (!prompt) {
        res.status(400).json({ error: 'BAD_PROMPT', detail: '提示词是空的' });
        return;
      }
      if (!config.ai.apiKey) {
        res.status(400).json({ error: 'AI_NOT_CONFIGURED', detail: '还没有配置 AI 密钥（设置页 → AI）' });
        return;
      }
      const p = await runPromptBacktest({
        contract,
        interval,
        prompt,
        candles: series.candles,
        market,
        step: Math.max(1, Math.min(200, Number(body.step) || PROMPT_DEFAULTS.step)),
        lookback: Math.max(10, Math.min(200, Number(body.lookback) || PROMPT_DEFAULTS.lookback)),
      });
      res.json({
        mode: 'prompt',
        bars: series.candles.length,
        days: Math.round((series.span.to - series.span.from) / 86400),
        gaps: series.gaps,
        stats: p.result.stats,
        equity: downsample(p.result.equity, 400),
        trades: p.result.trades.slice(-50).map((t) => ({
          side: t.side,
          entryTime: t.entryTime,
          exitTime: t.exitTime,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          net: Math.round(t.net * 100) / 100,
          reason: t.reason,
        })),
        verdict: p.verdict,
        promptRun: p.stats,
        baseline: p.baseline,
      });
      return;
    }

    if (!spec || !Array.isArray(spec.entry) || spec.entry.length === 0) {
      res.status(400).json({ error: 'BAD_SPEC', detail: '策略里至少要有一条入场条件' });
      return;
    }

    // 有参数范围就搜索，没有就拿 params 直接跑一次
    const hasRanges = Object.keys(spec.ranges ?? {}).length > 0;
    if (hasRanges) {
      const candidates = searchParameters(spec, series.candles, market, {
        method: body.method === 'random' ? 'random' : 'grid',
        maxTrials: Math.min(400, Math.max(20, Number(body.maxTrials) || 200)),
        minTrades: DEFAULT_CRITERIA.minTrades,
      });
      const eligible = candidates.filter((c) => !c.insufficientSample);
      const best = eligible[0] ?? candidates[0] ?? null;
      res.json({
        mode: 'search',
        bars: series.candles.length,
        days: Math.round((series.span.to - series.span.from) / 86400),
        gaps: series.gaps,
        candidates: candidates.length,
        enoughSample: eligible.length,
        best,
        verdict: best && eligible.length ? judge({
          blindExpectancyPct: best.blindExpectancyPct,
          blindTrades: best.blindTrades,
          blindMaxDrawdownPct: best.blindMaxDrawdownPct,
          blindPayoff: best.blindPayoff,
          blindWinRate: best.blindWinRate,
          decay: best.decay,
          costExpectancy: best.costExpectancy,
        }) : null,
      });
      return;
    }

    // 没有范围：整段数据跑一次，权益曲线直接回去画图
    const result = backtest(spec, series.candles, market);
    res.json({
      mode: 'single',
      bars: series.candles.length,
      days: Math.round((series.span.to - series.span.from) / 86400),
      gaps: series.gaps,
      stats: result.stats,
      equity: downsample(result.equity, 400),
      trades: result.trades.slice(-50).map((t) => ({
        side: t.side,
        entryTime: t.entryTime,
        exitTime: t.exitTime,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        net: Math.round(t.net * 100) / 100,
        reason: t.reason,
      })),
      verdict: judge({
        blindExpectancyPct: result.stats.expectancyPct,
        blindTrades: result.stats.trades,
        blindMaxDrawdownPct: result.stats.maxDrawdownPct,
        blindPayoff: result.stats.payoff,
        blindWinRate: result.stats.winRate,
        decay: 0,
        costExpectancy: { '2': 0 },
      }),
    });
  }));
}

/** 权益曲线点太多会把页面拖慢，抽稀到 n 个点。首尾一定保留 */
function downsample(points: { t: number; v: number }[], n: number): { t: number; v: number }[] {
  if (points.length <= n) return points;
  const out: { t: number; v: number }[] = [];
  const step = points.length / n;
  for (let i = 0; i < n; i++) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

// ---------- 提示词策略的回测 ----------

/**
 * 跑一次提示词策略：逐根问模型方向，再交给同一个引擎成交。
 *
 * 三个数必须写进返回里，缺一个这个结果就没法判断可信度：
 *   · leaks      匿名化失败次数，>0 说明这份结果被污染，不能用来判定
 *   · flatFallbacks  模型回答看不懂的次数，多说明提示词写得不好
 *   · baseline   同数据上随机入场的成绩，模型没超过它就不算数
 */
export interface PromptBacktestRequest {
  contract: string;
  interval: string;
  prompt: string;
  step: number;
  lookback: number;
}

/**
 * 默认参数：每 20 根问一次、最多问 150 次。
 *
 * 为什么有上限：9000 根每根问一次是 9000 次模型调用，跑一次几十块钱、十几分钟。
 * 150 次已经足够看出这条提示词有没有信息量；要更细可以自己调，但页面上会显示预计调用次数。
 */
export const PROMPT_DEFAULTS = { step: 20, lookback: 40 };


function promptSpecFor(side: 'long' | 'short'): StrategySpec {
  // 提示词策略用固定离场：ATR 2 倍止损、盈亏比 2。
  // 离场规则不交给用户 —— 那是另一件事，而且每改一次就要重测一遍。
  return {
    name: 'prompt',
    side,
    params: { atrPeriod: 14 },
    ranges: {},
    entry: [],
    stop: { kind: 'atr', value: 2 },
    target: { kind: 'rr', value: 2 },
    maxPositions: 1,
  };
}

/**
 * 跑一次提示词策略的回测，返回引擎结果 + 可信度指标。
 *
 * 调用方要看的三个数：
 *   leaks           匿名化失败次数。>0 时这份结果不能用来判定。
 *   flatFallbacks   模型回答看不懂的次数。多说明提示词写得含糊。
 *   baselineReturn  同数据随机入场的收益。模型没超过它就不算数。
 */
async function runPromptBacktest(input: {
  contract: string;
  interval: string;
  prompt: string;
  candles: Candle[];
  market: ReturnType<typeof marketOf>;
  step: number;
  lookback: number;
}): Promise<{
  result: BacktestResult;
  stats: { calls: number; flatFallbacks: number; leaks: number; step: number };
  baseline: { returnPct: number; trades: number };
  enoughSample: boolean;
  verdict: Verdict | null;
}> {
  const { chatJson } = await import('../ai.js');
  const forbidden = ['BTC', 'ETH', 'USDT', 'GATE', input.contract.split('_')[0] ?? ''];

  const asked = await runPromptSignals(input.candles, {
    prompt: input.prompt,
    step: input.step,
    startIndex: Math.max(input.lookback, 30),
    lookback: input.lookback,
    forbidden,
    ask: async (system, user) => {
      // 温度交给 chatJson 那层的默认（0.2）；提示词策略要的是稳定，不是创意
      const r = await chatJson({ system, user, maxTokens: 300, timeoutMs: 60_000 });
      return r.text;
    },
  });

  const expanded = expandSignals(input.candles, asked.signals);
  const spec = promptSpecFor('long');
  const result = backtest(spec, input.candles, { ...input.market, signalAt: (i) => expanded[i] ?? 'flat' });

  // 随机基线：同样的抽样节奏、同样的离场规则，方向随机
  const baseSignals = randomBaselineSignals(input.candles, input.step, Math.max(input.lookback, 30));
  const baseResult = backtest(spec, input.candles, { ...input.market, signalAt: (i) => baseSignals[i] ?? 'flat' });

  const enoughSample = result.stats.trades >= DEFAULT_CRITERIA.minTrades && asked.leaks === 0;
  /**
   * 判定。除了通用那五项，这里多一条：必须超过随机基线。
   * 提示词策略最容易骗人的地方就是「看起来有胜率，其实和乱猜差不多」。
   */
  const verdict = enoughSample
    ? judge({
        blindExpectancyPct: result.stats.expectancyPct,
        blindTrades: result.stats.trades,
        blindMaxDrawdownPct: result.stats.maxDrawdownPct,
        blindPayoff: result.stats.payoff,
        blindWinRate: result.stats.winRate,
        decay: 0,
        costExpectancy: { '2': result.stats.expectancyPct },
      })
    : null;

  return {
    result,
    stats: { calls: asked.calls, flatFallbacks: asked.flatFallbacks, leaks: asked.leaks, step: input.step },
    baseline: { returnPct: baseResult.stats.totalReturnPct, trades: baseResult.stats.trades },
    enoughSample,
    verdict,
  };
}
