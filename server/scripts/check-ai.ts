
/**
 * AI 交易链路的自检。
 *
 *   node/tsx server/scripts/check-ai.ts
 *
 * 全部离线跑：模型换成一个本地假接口（按系统提示词分辨角色），交易所那一段换成假 deps。
 * 所以这个脚本既不花钱，也不依赖你的密钥，更不会动真实仓位。
 *
 * 覆盖的是最容易悄悄错掉的那几处：
 *   1. 闸门算张数：单笔风险、保证金、最小下单量三条谁夹住谁。
 *   2. 该拒的必须拒：没止损、止损挂反、盈亏比不够、置信度不够、已有仓、日内亏损。
 *   3. 「15%」这种百分比不能变成价位（上游踩过的坑）。
 *   4. 多角色协议真能跑完，且角色数对得上档位。
 *   5. 执行器：一轮决策 → 放行 → 发单 → 落日志；开关关掉就什么也不做；亏到上限就熔断。
 */

import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 这一行必须在任何 import '../src/*' 之前：config.ts 是在模块加载时读环境的。
// HOME_DIR 指到临时目录，免得把策略文件和日志写进仓库。
const home = mkdtempSync(join(tmpdir(), 'xfrine-ai-check-'));
process.env.XFRINE_HOME = home;
process.env.GATE_ENV = 'testnet';
process.env.LIVE_TRADING = 'true';
process.env.AI_API_KEY = 'stub-key';
process.env.AI_MODEL = 'stub-model';

let fails = 0;
let passes = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passes += 1; console.log('  ✓ ' + name); }
  else { fails += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

// ---------- 假模型：按系统提示词认角色 ----------

type Mode = 'normal' | 'percentStop' | 'hold';

function stubReply(system: string, mode: Mode): string {
  if (system.includes('行情分析师')) {
    return '现价贴着 62000 那条被触及 6 次的支撑，距现价 -1.2%。ATR 是 210，占现价 0.34%，波动收着。上方 63500 是阻力，触及概率 61%。结构上更偏向：多';
  }
  if (system.includes('新闻与情绪分析师')) {
    return '三条标题里有一条只是提到了同一个词，实际不相关。情绪分 0.31 与标题语气一致。没有互相矛盾的报道。新闻面更偏向：中性';
  }
  if (system.includes('多头研究员')) {
    return '空头说上方阻力密集，但 62000 这条支撑被验证过 6 次且从未跌穿，ATR 只有 0.34%，这种波动下打穿的概率不高。做多的理由是止损可以放得很近。';
  }
  if (system.includes('空头研究员')) {
    return '多头忽略了 63500 上方连续三条阻力，触及概率 61%，价格到那里更容易停。做空的理由是上方空间被反复证伪。';
  }
  if (system.includes('研究主管')) {
    return '研究结论：偏多。采信多头那条「支撑被验证 6 次」的论据，空头的阻力论据成立但要看价格先走到哪里。';
  }
  if (system.includes('风控委员会')) {
    if (system.includes('保守')) return JSON.stringify({ stance: 'shrink', concern: '止损离 ATR 只有 0.9 倍，偏近', suggestion: '把止损挪到 61800 以下' });
    if (system.includes('激进')) return JSON.stringify({ stance: 'approve', concern: '没有明显问题', suggestion: '不用改' });
    return JSON.stringify({ stance: 'approve', concern: '规则都对得上', suggestion: '不用改' });
  }
  if (system.includes('组合经理')) {
    if (mode === 'hold') {
      return JSON.stringify({
        action: 'hold', confidence: 0.4, entry_type: 'market', entry: null, stop: null, target: null,
        horizon_hours: 0, reasoning: '证据不够', reasons: ['支撑和阻力势均力敌'], conflicts: [],
        vetoes: [], risk_note: '方向一旦出来这个判断就作废',
      });
    }
    return JSON.stringify({
      action: 'long', confidence: 0.72, entry_type: 'market', entry: null,
      stop: 61650, target: 63400, horizon_hours: 6,
      reasoning: '在 6 次验证过的支撑上方做多，止损放在支撑下方一个 ATR 之外',
      reasons: ['支撑被触及 6 次且守住', 'ATR 只有 0.34%，止损距离可控'],
      conflicts: ['上方 63500 有三条阻力，空间可能不够'],
      vetoes: ['采纳保守委员的意见，止损挪到 61650'],
      risk_note: '价格先跌穿 62000 且收盘站稳，这个判断就不成立',
    });
  }
  // 交易员
  const stop = mode === 'percentStop' ? '15%' : 61650;
  return JSON.stringify({
    action: mode === 'hold' ? 'hold' : 'long',
    confidence: 0.72,
    entry_type: 'market',
    entry: null,
    stop,
    target: 63400,
    horizon_hours: 6,
    reasoning: '在支撑上方做多',
    reasons: ['支撑被触及 6 次', 'ATR 占比低'],
    conflicts: [],
  });
}

let stubMode: Mode = 'normal';

async function startStub(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let system = '';
      try {
        const parsed = JSON.parse(body);
        system = String(parsed?.messages?.[0]?.content ?? '');
      } catch { /* 体不合法就按交易员处理 */ }
      const content = stubReply(system, stubMode);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'stub-model',
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: 'http://127.0.0.1:' + port + '/v1', close: () => server.close() };
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  const stub = await startStub();
  process.env.AI_BASE_URL = stub.url;

  // import 放在设置环境之后：config.ts 是加载时读环境的
  const strat = await import('../src/aiStrategy.js');
  const { decide } = await import('../src/ai.js');
  const { AiRunner } = await import('../src/aiRunner.js');

  const base = strat.sanitizeStrategy({
    enabled: true, strategyId: 'st_test', contracts: ['BTC_USDT'], interval: '15m', depth: 'standard',
    leverage: 10, riskPct: 0.5, maxPositions: 2, maxDailyLossPct: 3,
    minConfidence: 0.55, minRR: 1.5, maxMarginPct: 40, cooldownMin: 15, stopAtrMult: 0.8,
  });

  const info = { multiplier: 0.01, sizeMin: 1, sizeMax: 1000, leverageMax: 25, takerFee: 0.0005, lastPrice: 62000 };
  const account = { total: 1000, available: 1000 };
  const market = { last: 62000, atr: 210 };

  console.log('\n[1] 闸门：张数由「单笔风险」和「可用保证金」谁小听谁的');
  {
    // 止损距离 350（62000-61650）；每张风险 350*0.01 = 3.5 USDT
    // 单笔预算 1000*0.5% = 5 USDT → sizeByRisk = floor(5/3.5) = 1
    // 每张保证金 62000*0.01/10 = 62 → 预算 400 → sizeByMargin = 6
    const g = strat.gatePlan(base, {
      plan: { action: 'long', confidence: 0.72, entry: null, stop: 61650, target: 63400 },
      market, info, account, openPositions: 0, contractHasPosition: false, dayLossPct: 0,
    });
    ok('放行', g.ok, g.refusals.join(' / '));
    eq('张数', g.size, 1);
    eq('被哪条夹住', g.binding, '单笔风险');
    eq('这一笔的风险敞口', g.riskUsd, 3.5);
    // 止盈 63400、入场 62000（没给入场价就按现价）、止损 61650 → (1400 / 350) = 4
    ok('盈亏比算对了', Math.abs(g.rr - 4) < 0.01, String(g.rr));
  }

  console.log('\n[2] 该拒的一个都不能放');
  const refuse = (name: string, patch: Partial<Parameters<typeof strat.gatePlan>[1]>, want: string) => {
    const input = {
      plan: { action: 'long' as const, confidence: 0.72, entry: null, stop: 61650, target: 63400 },
      market, info, account, openPositions: 0, contractHasPosition: false, dayLossPct: 0,
      ...patch,
    };
    const g = strat.gatePlan(base, input as Parameters<typeof strat.gatePlan>[1]);
    ok(name, !g.ok && g.refusals.join(' ').includes(want), g.refusals.join(' / ') || '（居然放行了）');
  };
  refuse('没给止损', { plan: { action: 'long', confidence: 0.72, entry: null, stop: null, target: 63400 } }, '止损');
  refuse('止损挂反了', { plan: { action: 'long', confidence: 0.72, entry: null, stop: 63000, target: 64000 } }, '下方');
  refuse('止损太近（0.3×ATR）', { plan: { action: 'long', confidence: 0.72, entry: null, stop: 61940, target: 63400 } }, '止损距离');
  refuse('盈亏比不够', { plan: { action: 'long', confidence: 0.72, entry: null, stop: 61650, target: 62150 } }, '盈亏比');
  refuse('没给止盈', { plan: { action: 'long', confidence: 0.72, entry: null, stop: 61650, target: null } }, '盈亏比');
  refuse('置信度不够', { plan: { action: 'long', confidence: 0.3, entry: null, stop: 61650, target: 63400 } }, '置信度');
  refuse('这个合约已经有仓', { contractHasPosition: true }, '重复开仓');
  refuse('同时持仓到上限', { openPositions: 2 }, '持仓数');
  refuse('日内亏损到上限', { dayLossPct: 3.2 }, '日内亏损');
  refuse('观望', { plan: { action: 'hold', confidence: 0.9, entry: null, stop: null, target: null } }, '观望');

  console.log('\n[3] 权益太小、一手都开不了时要说清是哪条堵住了');
  {
    const g = strat.gatePlan(base, {
      plan: { action: 'long', confidence: 0.72, entry: null, stop: 61650, target: 63400 },
      market, info: { ...info, sizeMin: 5 }, account: { total: 20, available: 20 },
      openPositions: 0, contractHasPosition: false, dayLossPct: 0,
    });
    ok('拒掉', !g.ok);
    ok('说明里带着两个数', g.refusals.join(' ').includes('保证金侧'), g.refusals.join(' / '));
  }

  console.log('\n[4] 「15%」不能变成价位');
  {
    stubMode = 'percentStop';
    // 用 quick 档：标准档最终采信的是组合经理那份，测不到交易员的字段转换
    const d = await decide(fakeSnapshot(), { depth: 'quick' });
    eq('百分比止损被丢弃', d.plan.stop, null);
    ok('同一份里的止盈还在', d.plan.target === 63400, String(d.plan.target));
    stubMode = 'normal';
  }

  console.log('\n[5] 多角色协议：standard 档应当有 7 步');
  {
    const snap = fakeSnapshot();
    const d = await decide(snap, { depth: 'standard' });
    eq('角色数', d.turns.length, 7);
    eq('方向', d.plan.action, 'long');
    ok('止损解出来了', d.plan.stop === 61650, String(d.plan.stop));
    ok('降级说明没有出现', !d.turns.some((t) => t.role === 'pm_fallback'), '');
    ok('token 用量统计了', d.usage.calls === 7 && d.usage.promptTokens === 700, JSON.stringify(d.usage));
  }

  console.log('\n[6] quick 档只有 1 步');
  {
    const d = await decide(fakeSnapshot(), { depth: 'quick' });
    eq('角色数', d.turns.length, 1);
  }

  console.log('\n[7] 执行器：一轮决策 → 放行 → 发单');
  {
    strat.saveStrategy({ ...base, dayKey: '', dayStartEquity: 0 });
    const calls: string[] = [];
    let modelCalls = 0;
    const runner = new AiRunner({
      snapshot: async () => fakeSnapshot(),
      contractMeta: async () => info,
      account: async () => account,
      openPositions: async () => [],
      recentCandles: async () => risingCandles(),
      // 规则策略不该问模型。这里故意让它抛错：一旦被调用，测试立刻失败
      askModel: async () => { modelCalls += 1; throw new Error('规则策略不该调用模型'); },
      binding: (id: string) => (id === 'st_test' ? ruleBinding() : null),
      execute: async (req) => {
        calls.push(req.contract + ':' + req.side + ':' + req.size + ':' + req.stop + ':' + req.target);
        return { id: 'ord-1', status: 'finished', fillPrice: 62010, size: req.size };
      },
    });
    const rec = await runner.tick();
    ok('产出了记录', Boolean(rec));
    ok('闸门放行', Boolean(rec?.gate.ok), rec?.gate.refusals.join(' / ') ?? '');
    ok('真的发了一单', Boolean(rec?.exec.ok), rec?.exec.error ?? '');
    // 价位由策略算：ATR 210 × 1.5 = 315 的止损、盈亏比 2 的止盈
    // 62000 - 315 = 61685，62000 + 630 = 62630
    eq('发单参数（止损止盈来自策略，不是模型）', calls, ['BTC_USDT:long:1:61685:62630']);
    eq('规则策略一次模型都没调', modelCalls, 0);
    ok('日志落盘了', existsSync(join(home, 'ai-decisions.jsonl')) &&
      readFileSync(join(home, 'ai-decisions.jsonl'), 'utf8').trim().split('\n').length === 1);
    eq('计数：决策 1 单 1', runner.status().counts, { decisions: 1, orders: 1, refusals: 0, errors: 0 });

    // 关掉开关：必须什么都不做
    strat.saveStrategy({ ...base, enabled: true });
    const off = await runner.tick();
    ok('两分钟内不会连做两次', off === null && runner.status().skip.includes('两分钟'), runner.status().skip);
    strat.saveStrategy({ ...base, enabled: false });
    const off2 = await runner.tick();
    ok('关掉之后什么都不做', off2 === null && runner.status().skip === '策略没开', runner.status().skip);
  }

  console.log('\n[8] 熔断：日内亏损到上限就停下');
  {
    const today = strat.dayKeyOf();
    strat.saveStrategy({
      ...base, enabled: true, maxDailyLossPct: 1,
      dayKey: today, dayStartEquity: 1000, haltUntil: 0, haltReason: '',
    });
    const runner = new AiRunner({
      snapshot: async () => fakeSnapshot(),
      contractMeta: async () => info,
      account: async () => ({ total: 980, available: 980 }),
      openPositions: async () => [],
      recentCandles: async () => risingCandles(),
      askModel: async () => '{"side":"flat"}',
      binding: (id: string) => (id === 'st_test' ? ruleBinding() : null),
      execute: async () => { throw new Error('不该走到这一步'); },
    });
    const rec = await runner.tick(true);
    const saved = strat.loadStrategy();
    ok('这一轮没做决策', rec === null, String(rec?.id));
    ok('写下了熔断原因', saved.haltReason.includes('2.00%'), saved.haltReason);
    ok('熔断到明天', saved.haltUntil > Date.now(), String(saved.haltUntil));
    eq('当日亏损算对了', Math.round(strat.dayLossPct(saved, 980) * 100) / 100, 2);
  }

  console.log('\n[9] 配置文件被改坏时回到「什么都没开」');
  {
    const path = join(home, 'ai-strategy.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{ 这不是 json');
    const cfg = strat.loadStrategy();
    // 合约池现在由策略推导，默认是空的 —— 空池 + enabled=false 才是"什么都没开"的正确状态
    ok('坏文件读成「什么都没开」', cfg.enabled === false && cfg.contracts.length === 0, JSON.stringify(cfg.contracts));
    ok('也没有绑定的策略', cfg.strategyId === '', cfg.strategyId);
  }

  console.log('\n[10] 没有达标的策略就不能下单');
  {
    const { checkRunnable, bindingOf } = strat;
    const cfg = { ...base, enabled: true, strategyId: '' };
    const none = checkRunnable(cfg, null);
    ok('没选策略就不让跑', !none.ok && none.reason.includes('还没选策略'), none.reason);

    const missing = checkRunnable({ ...cfg, strategyId: 'gone' }, null);
    ok('策略被删了也不让跑', !missing.ok && missing.reason.includes('不在了'), missing.reason);

    const noRun = bindingOf({ id: 'a', name: 'A', contract: 'BTC_USDT', interval: '1h', lastRun: null });
    const r1 = checkRunnable({ ...cfg, strategyId: 'a' }, noRun);
    ok('没跑过回测不让跑', !r1.ok && r1.reason.includes('还没跑过回测'), r1.reason);

    const thin = bindingOf({ id: 'a', name: 'A', contract: 'BTC_USDT', interval: '1h', lastRun: { passed: true, failed: [], enoughSample: false } });
    const r2 = checkRunnable({ ...cfg, strategyId: 'a' }, thin);
    ok('样本不够不让跑', !r2.ok && r2.reason.includes('样本不够'), r2.reason);

    const failed = bindingOf({ id: 'a', name: 'A', contract: 'BTC_USDT', interval: '1h', lastRun: { passed: false, failed: ['样本外期望'], enoughSample: true } });
    const r3 = checkRunnable({ ...cfg, strategyId: 'a' }, failed);
    ok('没达标不让跑，并说出原因', !r3.ok && r3.reason.includes('样本外期望'), r3.reason);

    const good = bindingOf({ id: 'a', name: 'A', contract: 'BTC_USDT', interval: '1h', lastRun: { passed: true, failed: [], enoughSample: true } });
    const r4 = checkRunnable({ ...cfg, strategyId: 'a' }, good);
    ok('达标的策略可以跑', r4.ok, r4.reason);
    ok('合约只取策略训练的那个币', good?.contract === 'BTC_USDT', String(good?.contract));
    ok('周期也取策略的', good?.interval === '1h', String(good?.interval));
  }

  // 执行器这一层：没选策略时，一轮什么都不做
  {
    strat.saveStrategy({ ...base, enabled: true, strategyId: '' });
    let executed = 0;
    const runner = new AiRunner({
      snapshot: async () => fakeSnapshot(),
      contractMeta: async () => info,
      account: async () => account,
      openPositions: async () => [],
      recentCandles: async () => risingCandles(),
      askModel: async () => '{"side":"flat"}',
      binding: () => null,
      execute: async () => { executed += 1; throw new Error('不该下单'); },
    });
    const rec = await runner.tick(true);
    ok('没选策略时这一轮不决策', rec === null);
    ok('也没有发出任何单', executed === 0);
    ok('停下的原因写在 skip 里', runner.status().skip.includes('还没选策略'), runner.status().skip);
    strat.saveStrategy({ ...base, enabled: true, strategyId: 'st_test' });
  }

  console.log('\\n[11] 策略库：不跑回测也能存，但改规则会清掉旧结论');
  {
    const lib = await import('../src/quant/library.js');
    const spec = {
      name: 'x', side: 'long' as const, params: { n: 20, atrPeriod: 14 }, ranges: {},
      entry: [{ left: { name: 'close' }, op: '>' as const, right: { name: 'highest', periodKey: 'n' } }],
      stop: { kind: 'atr' as const, value: 1.5 }, target: { kind: 'rr' as const, value: 2 }, maxPositions: 1,
    };

    // 没跑过回测，直接存 —— 这是允许的
    const s1 = lib.saveStrategy({ name: '草稿', kind: 'rule', contract: 'BTC_USDT', interval: '1h', spec });
    ok('不跑回测也能存', Boolean(s1.id));
    ok('存下来的策略没有任何回测结论', s1.lastRun === null, JSON.stringify(s1.lastRun));

    // 改名不该清结论。先造一个结论，再改名
    const fakeResult = { stats: { expectancyPct: 0.3, trades: 40, payoff: 1.7, maxDrawdownPct: 10 } };
    const withRun = lib.recordRun(s1.id, fakeResult as never, {
      passed: true, failed: [], enoughSample: true, contract: 'BTC_USDT', interval: '1h',
    });
    ok('结论记上了', withRun?.lastRun?.passed === true);
    const renamed = lib.renameStrategy(s1.id, '改过名');
    ok('改名成功', renamed?.name === '改过名', renamed?.name);
    ok('改名不清回测结论', renamed?.lastRun?.passed === true, JSON.stringify(renamed?.lastRun));

    // 改规则要清结论 —— 那条结论对应的是旧规则
    const changed = { ...spec, stop: { kind: 'atr' as const, value: 3 } };
    const s2 = lib.saveStrategy({ id: s1.id, name: '改过名', kind: 'rule', contract: 'BTC_USDT', interval: '1h', spec: changed });
    ok('改了规则之后旧结论作废', s2.lastRun === null, JSON.stringify(s2.lastRun));

    // 只有名字变了，规则没变，结论要留着
    lib.recordRun(s1.id, fakeResult as never, { passed: true, failed: [], enoughSample: true, contract: 'BTC_USDT', interval: '1h' });
    const s3 = lib.saveStrategy({ id: s1.id, name: '再改个名', kind: 'rule', contract: 'BTC_USDT', interval: '1h', spec: changed });
    ok('只改名字不动规则，结论保留', s3.lastRun?.passed === true, JSON.stringify(s3.lastRun));

    // 合约名带尾随空格：界面上看不出来，但会让 Gate 的 URL 变成 ...%20 然后当它不存在
    const dirty = lib.saveStrategy({
      name: '带空格的', kind: 'rule', contract: '  btc_usdt  ', interval: ' 1h ',
      spec,
    });
    eq('合约名去掉空白并大写', dirty.contract, 'BTC_USDT');
    eq('周期去掉空白', dirty.interval, '1h');
    lib.deleteStrategy(dirty.id);

    lib.deleteStrategy(s1.id);
  }
  console.log('\\n[12] 提示词策略：实盘也匿名化，且只问一次模型');
  {
    strat.saveStrategy({ ...base, enabled: true, strategyId: 'st_prompt', contracts: [] });
    const seen: string[] = [];
    const calls: string[] = [];
    const runner = new AiRunner({
      snapshot: async () => fakeSnapshot(),
      contractMeta: async () => info,
      account: async () => account,
      openPositions: async () => [],
      recentCandles: async () => risingCandles(80),
      askModel: async (_system, user) => {
        seen.push(user);
        return '{"side":"long","confidence":0.7}';
      },
      binding: (id: string) => (id === 'st_prompt' ? promptBinding() : null),
      execute: async (req) => {
        calls.push(req.side + ':' + req.size);
        return { id: 'ord-9', status: 'finished', fillPrice: 62010, size: req.size };
      },
    });
    const rec = await runner.tick(true);
    ok('产出了记录', Boolean(rec));
    eq('方向来自模型', rec?.plan.action, 'long');
    eq('只问了一次模型', seen.length, 1);
    // 实盘和回测必须看到同一种输入，否则回测结论代表不了实盘
    const ctx = seen[0] ?? '';
    ok('发给模型的上下文里没有币种名', !/BTC|USDT/i.test(ctx), ctx.slice(0, 80));
    ok('上下文里没有真实年份', !/(19|20)[0-9]{2}/.test(ctx));
    ok('上下文里没有 6 万量级的绝对价格', !/6[0-9]{4}/.test(ctx));
    ok('上下文用的是归一化价格', /C=100\.000/.test(ctx), '没找到基准行');
    ok('真的按模型的方向下了单', rec?.exec.ok === true, rec?.exec.error ?? '');
    if (rec?.exec.ok) ok('下单方向是 long', calls[0]?.startsWith('long') === true, String(calls[0]));

    // 模型说 flat 就不做
    const flatRunner = new AiRunner({
      snapshot: async () => fakeSnapshot(),
      contractMeta: async () => info,
      account: async () => account,
      openPositions: async () => [],
      recentCandles: async () => risingCandles(80),
      askModel: async () => '{"side":"flat"}',
      binding: (id: string) => (id === 'st_prompt' ? promptBinding() : null),
      execute: async () => { throw new Error('flat 不该下单'); },
    });
    const rec2 = await flatRunner.tick(true);
    ok('模型判 flat 时不做', rec2?.plan.action === 'hold', String(rec2?.plan.action));
    ok('也没发单', rec2?.exec.ok === false);
  }
  stub.close();
  console.log('\n通过 ' + passes + ' 项，失败 ' + fails + ' 项');
  if (fails > 0) process.exitCode = 1;
}

/** 一份够用的材料。数字和上面的 stub 说法对得上 */

/** 一段单调上升的 K 线：最后一根收盘价一定高于前 20 根的最高，能稳定触发"突破前高" */
function risingCandles(n = 60) {
  const out = [];
  let px = 60000;
  for (let i = 0; i < n; i++) {
    px += 10;
    out.push({ t: 1700000000 + i * 900, o: px, h: px + 5, l: px - 5, c: px, v: 100 });
  }
  return out;
}

/** 一条能在上面那段 K 线上命中的规则策略 */
function ruleBinding(over: Record<string, unknown> = {}) {
  return {
    contract: 'BTC_USDT', interval: '15m', passed: true, failed: [], enoughSample: true,
    kind: 'rule' as const,
    prompt: null,
    spec: {
      name: 'breakout', side: 'long' as const, params: { n: 20, atrPeriod: 14 }, ranges: {},
      entry: [{ left: { name: 'close' }, op: '>' as const, right: { name: 'highest', periodKey: 'n' } }],
      stop: { kind: 'atr' as const, value: 1.5 },
      target: { kind: 'rr' as const, value: 2 },
      maxPositions: 1,
    },
    ...over,
  };
}

/** 一条提示词策略 */
function promptBinding(over: Record<string, unknown> = {}) {
  return {
    contract: 'BTC_USDT', interval: '15m', passed: true, failed: [], enoughSample: true,
    kind: 'prompt' as const,
    spec: null,
    prompt: '看最近的价格结构，判断下一根更可能往哪边走。',
    ...over,
  };
}

function fakeSnapshot() {
  return {
    contract: 'BTC_USDT',
    interval: '15m',
    last: 62000,
    atr: 210,
    rangeHigh: 64000,
    rangeLow: 60500,
    barsUsed: 200,
    spanHours: 50,
    barHigh: 64000,
    barLow: 60500,
    change24h: 1.2,
    levels: [
      {
        price: 62000, zone: [61800, 62200], role: '支撑', edge: 2.1,
        pTouch: 61, pHold: 74, nEvents: 6, pStall: 0.4, distancePct: -1.2, bucket: 'Q4',
      },
      {
        price: 63500, zone: [63300, 63700], role: '阻力', edge: 1.7,
        pTouch: 61, pHold: 58, nEvents: 4, pStall: 0.3, distancePct: 2.4, bucket: 'Q3',
      },
    ],
    news: { stance: 'neutral', sentiment: 0.31, headlines: ['Bitcoin holds key support', 'Analyst: BTC range persists'] },
  };
}

main().catch((e) => {
  console.error('自检本身抛异常：', e);
  process.exitCode = 1;
});