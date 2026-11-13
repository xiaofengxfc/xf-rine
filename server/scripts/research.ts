/**
 * 跑一次完整的 AI 研究：拉数据 → 模型提假设 → 回测搜索 → 判定，最多 N 轮。
 *
 *   pnpm research -- BTC_USDT 1h --rounds 3
 *   pnpm research -- ETH_USDT 4h --rounds 2 --capital 500
 *
 * 这是回测那一层唯一对外的命令行入口。页面跑的是同一套代码（routes 里调 research()），
 * 两条路共用 research.ts，不会出现"命令行能出结论、页面出来的数不一样"。
 *
 * 密钥从 server/.env 读，和页面用的是同一份。
 */

import { existsSync, readFileSync } from 'node:fs';
import { getSeries } from '../src/quant/data.js';
import { research, verdictLine } from '../src/quant/research.js';

const ENV_FILE = 'D:/github_xm/xf-rine/server/.env';

function loadAiEnv(): void {
  if (!existsSync(ENV_FILE)) return;
  const env = readFileSync(ENV_FILE, 'utf8');
  for (const k of ['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL']) {
    const m = new RegExp('^' + k + '=(.*)$', 'm').exec(env);
    if (m && m[1]) process.env[k] = m[1].trim();
  }
}

function arg(name: string, def: string, argv: string[]): string {
  const i = argv.indexOf('--' + name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v ?? def;
}

async function main(): Promise<void> {
  if (!process.env.XFRINE_HOME) process.env.XFRINE_HOME = 'D:/github_xm/xf-rine/.scratch/quant-probe';
  loadAiEnv();

  // pnpm 会把 "pnpm research -- A B" 里的 "--" 原样传下来，得先摘掉
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const contract = (argv[0] ?? 'BTC_USDT').toUpperCase();
  const interval = argv[1] ?? '1h';
  const rounds = Number(arg('rounds', '3', argv));
  const capital = Number(arg('capital', '1000', argv));
  const bars = Number(arg('bars', '9000', argv));

  console.log('合约 ' + contract + '，周期 ' + interval + '，最多 ' + rounds + ' 轮，本金 ' + capital + ' USDT');
  const s = await getSeries(contract, interval, bars);
  if (s.candles.length < 300) {
    console.error('只拿到 ' + s.candles.length + ' 根 K 线，太短，不做研究');
    process.exit(1);
  }
  console.log('数据 ' + s.candles.length + ' 根，覆盖 ' + ((s.span.to - s.span.from) / 86400).toFixed(0) + ' 天，断档 ' + s.gaps);

  const rep = await research({
    contract,
    interval,
    candles: s.candles,
    gaps: s.gaps,
    market: {
      multiplier: 0.0001,
      feeRate: 0.0005,
      slippagePct: 0.0002,
      capital,
      riskPerTrade: 0.5,
      leverage: 5,
      fundingRatePer8h: 0.0001,
    },
    maxRounds: rounds,
    onRound: (r) => {
      const conds = r.hypothesis.entry
        .map((c) => c.left.name + '(' + (c.left.periodKey ?? '') + ') ' + c.op + ' ' + (c.rightParam ?? c.right.name))
        .join('  且  ');
      console.log('');
      console.log('-- 第 ' + r.round + ' 轮 --');
      console.log('  假设：' + r.hypothesis.thesis);
      console.log('  条件：' + conds);
      if (!r.best) {
        console.log('  结果：没有任何候选成交');
        return;
      }
      console.log('  结果：候选 ' + r.candidates + ' 组，样本量够 ' + r.enoughSample + ' 组');
      console.log('  最优：样本外期望 ' + r.best.blindExpectancyPct.toFixed(3) + '%/笔，'
        + r.best.blindTrades + ' 笔，盈亏比 ' + r.best.blindPayoff
        + '，回撤 ' + r.best.blindMaxDrawdownPct.toFixed(1) + '%');
      console.log('  判定：' + (r.verdict
        ? (r.verdict.passed ? '达标' : '未通过 ' + r.verdict.failed.map((f) => f.label).join('、'))
        : '样本不足，不判定'));
    },
  });

  console.log('');
  console.log('=== 结论 ===');
  console.log(verdictLine(rep));
  if (rep.notes.length) {
    console.log('备注：');
    for (const n of rep.notes) console.log('  ' + n);
  }
  console.log('用时 ' + Math.round((rep.finishedAt - rep.startedAt) / 1000) + ' 秒');
}

main().catch((e) => {
  console.error('研究失败：', e);
  process.exitCode = 1;
});
