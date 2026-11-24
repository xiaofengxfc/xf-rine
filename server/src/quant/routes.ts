
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
import { bodyOf } from '../http/params.js';
import { exchange } from '../exchange/index.js';
import { config, exchangeLabel } from '../config.js';
import { getSeries } from './data.js';
import { backtest, warmupOf, type BacktestResult, type BacktestOpts, type StrategySpec, type Candle } from './backtest.js';
import { runPromptSignals, expandSignals, randomBaselineSignals, backtestPromptSignals } from './promptBacktest.js';
import { evaluateBlindCandidate, searchParametersWithProgress, splitCandles, type Candidate } from './search.js';
import { judge, DEFAULT_CRITERIA, type Verdict } from './criteria.js';
import { listStrategies, saveStrategy, deleteStrategy, recordRun, getStrategy, renameStrategy } from './library.js';
import { research, verdictLine, type ResearchReport } from './research.js';
import { INDICATORS } from './indicators.js';
import { buildZoneTimeline, zoneSeries, zonesByTime, toZonePoint, EMPTY_TIMELINE, type ZoneTimeline, type ZonePoint } from './zones.js';
import { FALLBACK_HYPOTHESIS, toSpec, type Hypothesis } from './ai.js';

/** 一次研究最多跑几轮。再多就是在拟合噪音，而且账单会很难看 */
const MAX_ROUNDS = 6;
/** 拉多少根 K 线。交易所每周期只留约 9000 根，要多了也没用 */
const MAX_BARS = 9000;

interface ContractMeta {
  multiplier: number;
  takerFee: number;
  sizeMin?: number;
  sizeStep?: number;
  sizeMax?: number;
  leverageMax?: number;
}

/**
 * 这个合约在 Gate 上存不存在。
 *
 * 放在保存策略和开启 AI 交易之前：合约名写错（BTC 而不是 BTC_USDT、或者拼错、或者已下架）
 * 本身不是致命错误，但它会让后面的回测、下单各报一句英文或一句"0 根 K 线"，
 * 用户得一路倒推才知道是第一步就错了。在这里一次说清。
 */
export async function contractProblem(contract: string): Promise<string | null> {
  const name = String(contract ?? '').trim().toUpperCase();
  if (!name) return '没有填合约';
  if (!/^[A-Z0-9]+_[A-Z0-9]+$/.test(name)) {
    return '合约名要写成 BTC_USDT 这种形式，现在填的是「' + contract + '」';
  }
  try {
    await exchange().publicContract(name);
    return null;
  } catch {
    return exchangeLabel() + ' 上没有合约 ' + name + ' —— 名字写错了，或者它已经下架';
  }
}

/** Add the prompt strategy's same-data random-baseline requirement to its verdict. */
export function applyPromptBaseline(
  verdict: Verdict,
  strategyReturnPct: number,
  baselineReturnPct: number,
): Verdict {
  const baselineCheck = {
    key: 'baseline',
    label: '随机基线',
    pass: strategyReturnPct > baselineReturnPct,
    value: strategyReturnPct.toFixed(2) + '%',
    threshold: '> ' + baselineReturnPct.toFixed(2) + '%',
    why: '提示词策略必须超过同一段行情上的随机信号收益',
  };
  const checks = [...verdict.checks, baselineCheck];
  const failed = checks.filter((check) => !check.pass);
  return { passed: failed.length === 0, failed, checks };
}

/** 合约乘数和费率：回测要按它换算张数，不能拍脑袋 */
async function contractMeta(contract: string): Promise<ContractMeta> {
  const c = await exchange().publicContract(contract);
  return {
    multiplier: Number(c.quanto_multiplier) || 0.0001,
    takerFee: Number(c.taker_fee_rate) || 0.0005,
    sizeMin: Number(c.order_size_min) || 1,
    sizeStep: Number(c.size_step) || 1,
    sizeMax: Number(c.order_size_max) || 0,
    leverageMax: Number(c.leverage_max) || 0,
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
    riskPerTrade: Math.max(0.0005, Math.min(0.05, n('riskPerTrade', 0.005))),
    maxMarginPct: 0.4,
    leverage: n('leverage', 5),
    sizeMin: meta.sizeMin ?? 1,
    sizeStep: meta.sizeStep ?? 1,
    sizeMax: meta.sizeMax ?? 0,
    leverageMax: meta.leverageMax ?? 0,
    fundingRatePer8h: Number(body.fundingRatePer8h) || 0,
  };
}

function hasBlindEvaluation(candidate: Candidate | null | undefined): candidate is Candidate & {
  blindExpectancyPct: number;
  blindTrades: number;
  blindPayoff: number;
  blindWinRate: number;
  blindMaxDrawdownPct: number;
  decay: number;
  costExpectancy: Record<string, number>;
  blindResult: BacktestResult;
} {
  return Boolean(
    candidate
    && candidate.blindExpectancyPct !== undefined
    && candidate.blindTrades !== undefined
    && candidate.blindPayoff !== undefined
    && candidate.blindWinRate !== undefined
    && candidate.blindMaxDrawdownPct !== undefined
    && candidate.decay !== undefined
    && candidate.costExpectancy !== undefined
    && candidate.blindResult,
  );
}

function evaluateFixedRuleHoldout(spec: StrategySpec, candles: Candle[], opts: BacktestOpts): {
  result: BacktestResult;
  enoughSample: boolean;
  verdict: Verdict | null;
  evaluationBars: number;
} {
  const split = splitCandles(candles, warmupOf(spec));
  const train = backtest(spec, split.train, opts);
  const result = backtest(spec, split.blind, {
    ...opts,
    tradeStartIndex: split.blindTradeStartIndex,
  });
  const costMultiple = DEFAULT_CRITERIA.costStressMultiple;
  const stressed = backtest(spec, split.blind, {
    ...opts,
    tradeStartIndex: split.blindTradeStartIndex,
    feeRate: opts.feeRate * costMultiple,
    slippagePct: opts.slippagePct * costMultiple,
  });
  const enoughSample = result.stats.trades >= DEFAULT_CRITERIA.minTrades;
  const verdict = enoughSample ? judge({
    blindExpectancyPct: result.stats.expectancyPct,
    blindTrades: result.stats.trades,
    blindMaxDrawdownPct: result.stats.maxDrawdownPct,
    blindPayoff: result.stats.payoff,
    blindWinRate: result.stats.winRate,
    decay: train.stats.expectancyPct - result.stats.expectancyPct,
    costExpectancy: { [String(costMultiple)]: stressed.stats.expectancyPct },
  }) : null;

  return {
    result,
    enoughSample,
    verdict,
    evaluationBars: Math.max(0, split.blind.length - split.blindTradeStartIndex),
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
    const body = bodyOf(req.body);
    const kind = body.kind === 'prompt' ? 'prompt' : 'rule';
    const name = String(body.name ?? '').trim() || '未命名策略';
    // 去空白：手填时代留下的尾随空格会让 URL 变成 ...%20，交易所直接当不存在
    const contract = String(body.contract ?? 'BTC_USDT').trim().toUpperCase();
    const interval = String(body.interval ?? '1h').trim();

    // 存之前先确认这个合约真的存在，别让一条跑不了的策略进库
    const bad = await contractProblem(contract).catch(() => null);
    if (bad) {
      res.status(400).json({ error: 'BAD_CONTRACT', detail: bad });
      return;
    }

    try {
      const saved = saveStrategy({
        id: typeof body.id === 'string' && body.id ? body.id : undefined,
        name,
        kind,
        contract,
        interval,
        spec: kind === 'rule' ? (body.spec as StrategySpec) : null,
        prompt: kind === 'prompt' ? String(body.prompt ?? '') : null,
        // 风险参数跟着策略走，合法化在 library 里做（sanitizeRisk）
        risk: body.risk,
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
    const name = String(bodyOf(req.body).name ?? '');
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
    const body = bodyOf(req.body);
    /**
     * 策略内容默认从策略库读，请求体只作覆盖。
     *
     * URL 里已经有策略 id 了，再让调用方把 spec 原样传回来是多余的：
     * 传漏了就是一个「没有策略内容」的 400，而页面点「跑」的时候本来就没带它。
     * 实测踩到的就是这个 —— 策略明明在库里，却报「没有策略内容」。
     */
    const stored = getStrategy(String(req.params.id));
    const contract = String(body.contract ?? stored?.contract ?? 'BTC_USDT').trim().toUpperCase();
    const interval = String(body.interval ?? stored?.interval ?? '1h').trim();
    const kindRaw = body.kind ?? stored?.kind;
    const kind = kindRaw === 'prompt' ? 'prompt' : 'rule';
    const spec = (body.spec ?? (kind === 'rule' ? stored?.spec : undefined)) as StrategySpec | undefined;
    const prompt = String(body.prompt ?? stored?.prompt ?? '').trim();

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

    // 记结论这一路也要有同样的关键位序列，否则「按策略库跑一遍」和「按回测按钮跑一遍」数不一样
    const { virtual } = await zoneVirtual(contract, interval, series.candles);
    const hasRanges = Object.keys(spec.ranges ?? {}).length > 0;
    let run: { result: BacktestResult; enoughSample: boolean; verdict: Verdict | null };
    let selectedParams: Candidate['params'] | undefined;

    if (hasRanges) {
      // 搜索只使用训练和验证段，选定参数后才在盲测段做最终评估。
      const candidates = await searchParametersWithProgress(spec, series.candles, { ...market, virtual }, {
        minTrades: DEFAULT_CRITERIA.minTrades,
        evaluateBlind: false,
      });
      const eligible = candidates.filter((c) => !c.insufficientSample);
      const best = eligible[0] ?? candidates[0];
      if (!best) {
        res.status(400).json({ error: 'NO_TRADES', detail: '没有任何候选成交，这份策略在这段数据上跑不出结果' });
        return;
      }
      const evaluated = evaluateBlindCandidate(spec, series.candles, { ...market, virtual }, best, {
        minTrades: DEFAULT_CRITERIA.minTrades,
        costMultipliers: [DEFAULT_CRITERIA.costStressMultiple],
      });
      if (!hasBlindEvaluation(evaluated)) {
        res.status(400).json({ error: 'NO_TRADES', detail: '选定参数没有可判定的盲测结果' });
        return;
      }
      selectedParams = evaluated.params;
      const enoughSample = !evaluated.insufficientBlindSample;
      run = {
        result: evaluated.blindResult,
        enoughSample,
        verdict: enoughSample ? judge({
          blindExpectancyPct: evaluated.blindExpectancyPct,
          blindTrades: evaluated.blindTrades,
          blindMaxDrawdownPct: evaluated.blindMaxDrawdownPct,
          blindPayoff: evaluated.blindPayoff,
          blindWinRate: evaluated.blindWinRate,
          decay: evaluated.decay,
          costExpectancy: evaluated.costExpectancy,
        }) : null,
      };
    } else {
      run = evaluateFixedRuleHoldout(spec, series.candles, { ...market, virtual });
    }

    const saved = recordRun(String(req.params.id), run.result, {
      passed: run.verdict ? run.verdict.passed : false,
      failed: run.verdict ? run.verdict.failed.map((f) => f.label) : ['样本不足'],
      enoughSample: run.enoughSample,
      contract,
      interval,
    }, selectedParams);
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
    const body = bodyOf(req.body);
    // 去空白：手填时代留下的尾随空格会让 URL 变成 ...%20，交易所直接当不存在
    const contract = String(body.contract ?? 'BTC_USDT').trim().toUpperCase();
    const interval = String(body.interval ?? '1h').trim();
    const rounds = Math.min(MAX_ROUNDS, Math.max(1, Number(body.rounds) || 3));

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    // 关掉 Nagle：小包要立刻发出去，否则"第 1 轮开始"那行会在缓冲里躺着
    res.socket?.setNoDelay(true);
    res.flushHeaders();

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
        send({
          type: 'error',
          message: series.candles.length === 0
            ? 'Gate 上没有 ' + contract + ' 的 ' + interval + ' K 线 —— 合约名多半写错了'
            : '只拿到 ' + series.candles.length + ' 根 K 线（' + contract + ' ' + interval + '），太短，做不了研究',
        });
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
        // 细一档的进度：模型在想的时候页面也得动，否则看着就是「卡在回测中」
        onStage: (stage, message) => send({ type: 'stage', stage, message }),
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
            validateExpectancyPct: r.best.validateExpectancyPct,
            validateTrades: r.best.validateTrades,
            validatePayoff: r.best.validatePayoff,
            validateWinRate: r.best.validateWinRate,
            validateMaxDrawdownPct: r.best.validateMaxDrawdownPct,
            validateReturnPct: r.best.validateReturnPct,
            validateDecay: r.best.validateDecay,
            validateCostExpectancy: r.best.validateCostExpectancy,
          } : null,
          verdictStage: 'validation',
          verdict: r.verdict,
        }),
      });

      /**
       * 达标的那一条直接进策略库。
       *
       * 以前研究跑完只把结论打在事件流里：页面一刷、或者人走开一会儿，这次研究就白跑了 ——
       * 「假设通过了但结果没保存」说的就是这件事。现在自动存一条，并顺手把这次的回测结论
       * 记上（不记的话策略库里会显示「没跑过回测」，AI 交易页也会把它拦住）。
       */
      let saved: { id: string; name: string; spec: StrategySpec } | null = null;
      if (report.winner) {
        try {
          const when = new Date().toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
          });
          const name = (contract + ' ' + interval + ' · AI 达标 ' + when).slice(0, 60);
          // 参数取的是搜索出来的那一组，不是假设里的默认值 —— 否则存下来的是另一条策略
          const spec: StrategySpec = { ...toSpec(report.winner.hypothesis, name), params: report.winner.candidate.params };
          const row = saveStrategy({
            name, kind: 'rule', contract, interval, spec,
            // 和页面上的默认风险参数一致；AI 交易那边会按这条策略自己的数跑
            risk: { riskPct: 0.5, maxMarginPct: 40, stopAtrMult: 0.8 },
          });
          const blind = report.winner.candidate.blindResult;
          if (blind) {
            recordRun(row.id, blind, {
              passed: report.winner.verdict.passed,
              // 库里存的是给人看的一句话，判定项对象要在这里压成标签
              failed: (report.winner.verdict.failed ?? []).map((x) => x.label),
              enoughSample: !report.winner.candidate.insufficientSample,
              contract, interval,
            });
          }
          saved = { id: row.id, name: row.name, spec };
        } catch (e) {
          // 存不进去不能连累结论：报告照样发出去，只是多一行说明
          send({ type: 'note', message: '达标方案没能存进策略库：' + (e as Error).message });
        }
      }

      send({ type: 'done', report, verdict: verdictLine(report), saved });
      res.end();
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
      res.end();
    }
  }));

  /**
   * 流式回测：和普通回测使用同一套计算，但把数据、关键位、候选搜索和模型调用
   * 的进度用 NDJSON 发给前端，避免长任务只显示一个不会动的「回测中」。
   */
  router.post('/quant/backtest/stream', async (req: Request, res: Response) => {
    try {
      const body = bodyOf(req.body);
      const contract = String(body.contract ?? 'BTC_USDT').trim().toUpperCase();
      const interval = String(body.interval ?? '1h').trim();
      const kind = body.kind === 'prompt' ? 'prompt' : 'rule';
      const spec = body.spec as StrategySpec | undefined;

      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.socket?.setNoDelay(true);
      res.flushHeaders();
      const send = (event: unknown) => {
        if (!res.writableEnded) res.write(JSON.stringify(event) + String.fromCharCode(10));
      };

      send({ type: 'backtest-progress', stage: 'data', message: '拉 ' + contract + ' ' + interval + ' 的历史 K 线' });
      const series = await getSeries(contract, interval, MAX_BARS);
      if (series.candles.length < 300) {
        send({ type: 'backtest-error', message: series.candles.length === 0
          ? '没有拿到 ' + contract + ' 的 ' + interval + ' K 线 —— 合约名或周期可能不正确'
          : '只拿到 ' + series.candles.length + ' 根 K 线，太短，跑不出可信的回测' });
        res.end();
        return;
      }
      send({ type: 'backtest-progress', stage: 'data', message: '已拿到 ' + series.candles.length + ' 根 K 线' });
      const meta = await contractMeta(contract).catch(() => ({ multiplier: 0.0001, takerFee: 0.0005 }));
      const market = marketOf(meta, body);

      if (kind === 'prompt') {
        const prompt = String(body.prompt ?? '').trim();
        if (!prompt) {
          send({ type: 'backtest-error', message: '提示词是空的' });
          res.end();
          return;
        }
        if (!config.ai.apiKey) {
          send({ type: 'backtest-error', message: '还没有配置 AI 密钥（设置页 → AI）' });
          res.end();
          return;
        }
        const p = await runPromptBacktest({
          contract, interval, prompt, candles: series.candles, market,
          lookback: Math.max(10, Math.min(200, Number(body.lookback) || PROMPT_DEFAULTS.lookback)),
          onStage: (stage, message) => send({ type: 'backtest-progress', stage, message }),
          onProgress: (done, total) => {
            const stride = Math.max(1, Math.floor(total / 100));
            if (done === 1 || done === total || done % stride === 0) send({
              type: 'backtest-progress', stage: 'model', message: '逐根询问模型 ' + done + '/' + total, done, total,
            });
          },
        });
        send({ type: 'backtest-result', result: {
          mode: 'prompt',
          evaluationSegment: 'blind',
          bars: series.candles.length,
          days: Math.round((series.span.to - series.span.from) / 86400),
          gaps: series.gaps,
          stats: p.result.stats,
          equity: downsample(p.result.equity, 400),
          trades: p.result.trades.slice(-50).map((t) => ({
            side: t.side, entryTime: t.entryTime, exitTime: t.exitTime,
            entryPrice: t.entryPrice, exitPrice: t.exitPrice,
            net: Math.round(t.net * 100) / 100, reason: t.reason,
          })),
          verdict: p.verdict,
          promptRun: p.stats,
          baseline: p.baseline,
        }});
        res.end();
        return;
      }

      if (!spec || !Array.isArray(spec.entry) || spec.entry.length === 0) {
        send({ type: 'backtest-error', message: '策略里至少要有一条入场条件' });
        res.end();
        return;
      }
      send({ type: 'backtest-progress', stage: 'zones', message: '计算历史支撑阻力时间线' });
      const { virtual } = await zoneVirtual(contract, interval, series.candles, (done, total) => {
        if (done === 1 || done === total || done % Math.max(1, Math.floor(total / 10)) === 0) {
          send({ type: 'backtest-progress', stage: 'zones', message: '支撑阻力 ' + done + '/' + total, done, total });
        }
      });
      const hasRanges = Object.keys(spec.ranges ?? {}).length > 0;
      if (hasRanges) {
        const maxTrials = Math.min(400, Math.max(20, Number(body.maxTrials) || 200));
        const candidates = await searchParametersWithProgress(spec, series.candles, { ...market, virtual }, {
          method: body.method === 'random' ? 'random' : 'grid',
          maxTrials,
          minTrades: DEFAULT_CRITERIA.minTrades,
          evaluateBlind: false,
        }, ({ completed, total }) => send({
          type: 'backtest-progress', stage: 'search', message: '参数搜索 ' + completed + '/' + total,
          done: completed, total,
        }));
        const eligible = candidates.filter((c) => !c.insufficientSample);
        const validationBest = eligible[0] ?? candidates[0] ?? null;
        const evaluatedBest = validationBest
          ? evaluateBlindCandidate(spec, series.candles, { ...market, virtual }, validationBest, {
              minTrades: DEFAULT_CRITERIA.minTrades,
              costMultipliers: [DEFAULT_CRITERIA.costStressMultiple],
            })
          : null;
        const best = hasBlindEvaluation(evaluatedBest) ? evaluatedBest : null;
        const enoughBlindSample = Boolean(best && !best.insufficientBlindSample);
        send({ type: 'backtest-result', result: {
          mode: 'search',
          evaluationSegment: 'blind',
          bars: series.candles.length,
          days: Math.round((series.span.to - series.span.from) / 86400),
          gaps: series.gaps,
          candidates: candidates.length,
          enoughSample: eligible.length,
          best,
          verdict: best && enoughBlindSample ? judge({
            blindExpectancyPct: best.blindExpectancyPct,
            blindTrades: best.blindTrades,
            blindMaxDrawdownPct: best.blindMaxDrawdownPct,
            blindPayoff: best.blindPayoff,
            blindWinRate: best.blindWinRate,
            decay: best.decay,
            costExpectancy: best.costExpectancy,
          }) : null,
        }});
        res.end();
        return;
      }

      send({ type: 'backtest-progress', stage: 'backtest', message: '运行最终留出段并生成权益曲线' });
      const holdout = evaluateFixedRuleHoldout(spec, series.candles, { ...market, virtual });
      const result = holdout.result;
      send({ type: 'backtest-result', result: {
        mode: 'single',
        evaluationSegment: 'blind',
        bars: series.candles.length,
        days: Math.round((series.span.to - series.span.from) / 86400),
        gaps: series.gaps,
        stats: result.stats,
        equity: downsample(result.equity, 400),
        trades: result.trades.slice(-50).map((t) => ({
          side: t.side, entryTime: t.entryTime, exitTime: t.exitTime,
          entryPrice: t.entryPrice, exitPrice: t.exitPrice,
          net: Math.round(t.net * 100) / 100, reason: t.reason,
        })),
        verdict: holdout.verdict,
      }});
      res.end();
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'INTERNAL', detail: (e as Error).message });
      } else {
        if (!res.writableEnded) res.write(JSON.stringify({ type: 'backtest-error', message: (e as Error).message }) + String.fromCharCode(10));
        res.end();
      }
    }
  });

  /**
   * 手写策略直接回测。不经过模型 —— 编辑器里改完一行条件就按一下，看它到底行不行。
   * 和 AI 研究用的是同一个引擎、同一个判定，所以两边的数不会打架。
   */
  router.post('/quant/backtest', wrap(async (req: Request, res: Response) => {
    const body = bodyOf(req.body);
    // 去空白：手填时代留下的尾随空格会让 URL 变成 ...%20，交易所直接当不存在
    const contract = String(body.contract ?? 'BTC_USDT').trim().toUpperCase();
    const interval = String(body.interval ?? '1h').trim();
    const kind = body.kind === 'prompt' ? 'prompt' : 'rule';
    const spec = body.spec as StrategySpec | undefined;

    const series = await getSeries(contract, interval, MAX_BARS);
    if (series.candles.length < 300) {
      /**
     * 0 根 K 线几乎总是「合约名写错了」，不是「数据太短」。
     *
     * 以前统一报「只拿到 0 根 K 线」，用户看到这句话无从下手 ——
     * 到底是合约不对、周期不对、还是交易所没数据？现在分开说，
     * 并在 0 根时直接点出"这个合约在 Gate 上不存在"。
     */
    res.status(400).json({
      error: 'DATA_TOO_SHORT',
      detail: series.candles.length === 0
        ? 'Gate 上没有 ' + contract + ' 的 ' + interval + ' K 线 —— 合约名多半写错了，或者这个周期没有数据'
        : '只拿到 ' + series.candles.length + ' 根 K 线（' + contract + ' ' + interval + '），太短，跑不出可信的回测',
    });
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
        lookback: Math.max(10, Math.min(200, Number(body.lookback) || PROMPT_DEFAULTS.lookback)),
      });
      res.json({
        mode: 'prompt',
        evaluationSegment: 'blind',
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

    /**
     * 关键位时间线。规则策略可以引用「最近支撑价 / 最近阻力价」，
     * 那两个序列就是从这里来的 —— 滚动计算，第 i 根只用 i 之前的数据。
     */
    const { virtual } = await zoneVirtual(contract, interval, series.candles);

    // 有参数范围就搜索，没有就拿 params 直接跑一次
    const hasRanges = Object.keys(spec.ranges ?? {}).length > 0;
    if (hasRanges) {
      const candidates = await searchParametersWithProgress(spec, series.candles, { ...market, virtual }, {
        method: body.method === 'random' ? 'random' : 'grid',
        maxTrials: Math.min(400, Math.max(20, Number(body.maxTrials) || 200)),
        minTrades: DEFAULT_CRITERIA.minTrades,
        evaluateBlind: false,
      });
      const eligible = candidates.filter((c) => !c.insufficientSample);
      const validationBest = eligible[0] ?? candidates[0] ?? null;
      const evaluatedBest = validationBest
        ? evaluateBlindCandidate(spec, series.candles, { ...market, virtual }, validationBest, {
            minTrades: DEFAULT_CRITERIA.minTrades,
            costMultipliers: [DEFAULT_CRITERIA.costStressMultiple],
          })
        : null;
      const best = hasBlindEvaluation(evaluatedBest) ? evaluatedBest : null;
      const enoughBlindSample = Boolean(best && !best.insufficientBlindSample);
      res.json({
        mode: 'search',
        evaluationSegment: 'blind',
        bars: series.candles.length,
        days: Math.round((series.span.to - series.span.from) / 86400),
        gaps: series.gaps,
        candidates: candidates.length,
        enoughSample: eligible.length,
        best,
        verdict: best && enoughBlindSample ? judge({
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

    // 无参数搜索时也只用最终盲测段形成策略结论。
    const holdout = evaluateFixedRuleHoldout(spec, series.candles, { ...market, virtual });
    const result = holdout.result;
    res.json({
      mode: 'single',
      evaluationSegment: 'blind',
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
      verdict: holdout.verdict,
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
export const PROMPT_DEFAULTS = { lookback: 40 };


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
  lookback: number;
  onStage?: (stage: string, message: string) => void;
  onProgress?: (done: number, total: number) => void;
}): Promise<{
  result: BacktestResult;
  stats: { calls: number; flatFallbacks: number; leaks: number };
  baseline: { returnPct: number; trades: number };
  enoughSample: boolean;
  verdict: Verdict | null;
}> {
  const { chatJson } = await import('../ai.js');
  const forbidden = ['BTC', 'ETH', 'USDT', 'GATE', input.contract.split('_')[0] ?? ''];

  // 关键位也要有：模型看得到「上方最近的阻力在哪」和看得到价格一样重要。
  // 这段计算是本地引擎调用（热态 70ms 一次），跟逐根问模型的耗时比可以忽略
  input.onStage?.('zones', '计算提示词需要的支撑阻力时间线');
  const { timeline } = await zoneVirtual(input.contract, input.interval, input.candles, (done, total) => {
    if (done === 1 || done === total || done % Math.max(1, Math.floor(total / 10)) === 0) {
      input.onStage?.('zones', '支撑阻力 ' + done + '/' + total);
    }
  });

  const asked = await runPromptSignals(input.candles, {
    prompt: input.prompt,
    startIndex: Math.max(input.lookback, 30),
    lookback: input.lookback,
    forbidden,
    zonesByTime: zonesByTime(timeline, input.candles),
    onProgress: input.onProgress,
    ask: async (system, user) => {
      // 温度交给 chatJson 那层的默认（0.2）；提示词策略要的是稳定，不是创意
      const r = await chatJson({ system, user, maxTokens: 300, timeoutMs: 60_000 });
      return r.text;
    },
  });

  const expanded = expandSignals(input.candles, asked.signals);
  const spec = promptSpecFor('long');
  // 对比模型与随机信号时，两者只看同一段最终留出样本。
  const baseSignals = randomBaselineSignals(input.candles, Math.max(input.lookback, 30));
  const evaluated = backtestPromptSignals(
    input.candles,
    expanded,
    baseSignals,
    spec,
    input.market,
    warmupOf(spec),
    DEFAULT_CRITERIA.costStressMultiple,
  );
  const { result, baseline: baseResult, stressed } = evaluated;

  const enoughSample = result.stats.trades >= DEFAULT_CRITERIA.minTrades
    && baseResult.stats.trades >= DEFAULT_CRITERIA.minTrades
    && asked.leaks === 0;
  /**
   * 判定。除了通用那五项，这里多一条：必须超过随机基线。
   * 提示词策略最容易骗人的地方就是「看起来有胜率，其实和乱猜差不多」。
   */
  const verdict = enoughSample
    ? applyPromptBaseline(judge({
        blindExpectancyPct: result.stats.expectancyPct,
        blindTrades: result.stats.trades,
        blindMaxDrawdownPct: result.stats.maxDrawdownPct,
        blindPayoff: result.stats.payoff,
        blindWinRate: result.stats.winRate,
        decay: 0,
        costExpectancy: { [String(DEFAULT_CRITERIA.costStressMultiple)]: stressed.stats.expectancyPct },
      }), result.stats.totalReturnPct, baseResult.stats.totalReturnPct)
    : null;

  return {
    result,
    stats: { calls: asked.calls, flatFallbacks: asked.flatFallbacks, leaks: asked.leaks },
    baseline: { returnPct: baseResult.stats.totalReturnPct, trades: baseResult.stats.trades },
    enoughSample,
    verdict,
  };
}

// ---------- 关键位时间线 ----------

/** 周期代号：sidecar 只认这一套 */
const TF_CODE: Record<string, string> = {
  '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30',
  '1h': 'H1', '4h': 'H4', '8h': 'H8', '1d': 'D1',
};

/** 每多少根 K 线重算一次关键位。50 根是精度和耗时的折中：9000 根 → 180 次引擎调用，约十几秒 */
const ZONE_EVERY = 50;

/**
 * 拿一段 K 线去问引擎要关键位。
 *
 * 只喂 window（i 及之前的部分），不喂整段 —— 喂多了就是未来函数，
 * 而这正是「回测里的关键位」最容易骗人的地方。
 */
async function analyzeWindow(contract: string, interval: string, window: Candle[]): Promise<ZonePoint[]> {
  const { analyzeBars } = await import('../sr/client.js');
  const tf = TF_CODE[interval] ?? interval.toUpperCase();
  const bars = window.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));
  const r = await analyzeBars({
    symbol: contract, tf, frames: [{ tf, bars }], n_zones: 3, direction: 'both', mtf: false,
  } as Parameters<typeof analyzeBars>[0]);
  return r.zones.map(toZonePoint);
}

/**
 * 给回测准备外部序列：最近支撑价 / 最近阻力价。
 *
 * 引擎不可用时返回空对象，条件里的 zoneSupport/zoneResistance 会一直是 NaN，
 * 于是引用它们的条件恒不成立 —— 回测跑得出来但一笔不做，比直接报错更容易看懂。
 */
async function zoneVirtual(
  contract: string,
  interval: string,
  candles: Candle[],
  onProgress?: (done: number, total: number) => void,
): Promise<{
  virtual: Record<string, (i: number, c: Candle) => number>;
  timeline: ZoneTimeline;
}> {
  try {
    const timeline = await buildZoneTimeline(
      candles, ZONE_EVERY, 60, (w) => analyzeWindow(contract, interval, w), 300,
      onProgress ? ({ completed, total }) => onProgress(completed, total) : undefined,
    );
    if (timeline.slices.length === 0) return { virtual: {}, timeline };
    const series = zoneSeries(timeline, candles);
    return {
      virtual: { zoneSupport: series.support, zoneResistance: series.resistance },
      timeline,
    };
  } catch {
    return { virtual: {}, timeline: EMPTY_TIMELINE };
  }
}
