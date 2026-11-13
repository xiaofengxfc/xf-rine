
/**
 * 策略库。
 *
 * 存两类策略：
 *   · rule   —— 指标 + 条件 + 参数，能穷举搜索、完全可复现
 *   · prompt —— 一段给模型的指令，模型读行情上下文后给方向
 *
 * 两类都在同一个回测引擎里跑、用同一套判定。区别只在"方向从哪来"：
 * 规则策略由条件算，提示词策略由模型答。
 *
 * 合约不再是策略的身份证。以前的判断是"策略只在它训练过的币上有依据"，
 * 那条判断对训练有效，但它把一个自然需求堵死了：换一个币看一看。
 * 现在合约单独记在策略上，可以随时改，回测和实盘各用各的；
 * 判定里也加了"跨合约一致性"这一项来补回那份谨慎 —— 见 criteria.ts。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_DIR } from '../config.js';
import type { StrategySpec } from './backtest.js';
import type { BacktestResult } from './backtest.js';

export const LIBRARY_PATH = join(HOME_DIR, 'quant-strategies.json');

export type StrategyKind = 'rule' | 'prompt';

export interface SavedStrategy {
  id: string;
  name: string;
  kind: StrategyKind;
  /**
   * 默认跑哪个合约。只是默认值 —— 回测时可以临时换，实盘时也可以换。
   * 换了之后回测结论需要重跑，页面上会提示（lastRun.contract 记着是哪次跑出来的）。
   */
  contract: string;
  interval: string;
  /** 规则策略用；提示词策略留空 */
  spec: StrategySpec | null;
  /** 提示词策略：给模型的分析指令。规则策略为 null */
  prompt: string | null;
  createdAt: number;
  updatedAt: number;
  lastRun: {
    at: number;
    /** 这次回测是在哪个合约上跑的 —— 换了合约，这条结论就不作数了 */
    contract: string;
    interval: string;
    passed: boolean;
    failed: string[];
    expectancyPct: number;
    trades: number;
    payoff: number;
    maxDrawdownPct: number;
    enoughSample: boolean;
  } | null;
}

interface Library {
  strategies: SavedStrategy[];
}

function readLibrary(): Library {
  if (!existsSync(LIBRARY_PATH)) return { strategies: [] };
  try {
    const raw = JSON.parse(readFileSync(LIBRARY_PATH, 'utf8')) as Library;
    if (!Array.isArray(raw.strategies)) return { strategies: [] };
    // 老数据没有 kind 字段：有 spec 的按规则策略算
    for (const s of raw.strategies) {
      if (!s.kind) s.kind = s.spec ? 'rule' : 'prompt';
      if (s.prompt === undefined) s.prompt = null;
    }
    return raw;
  } catch {
    // 读坏了当作空库：不要拿半份配置去下单
    return { strategies: [] };
  }
}

function writeLibrary(lib: Library): void {
  mkdirSync(join(LIBRARY_PATH, '..'), { recursive: true });
  const tmp = LIBRARY_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(lib, null, 2) + String.fromCharCode(10), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, LIBRARY_PATH);
}

export function listStrategies(): SavedStrategy[] {
  return readLibrary().strategies.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getStrategy(id: string): SavedStrategy | null {
  return readLibrary().strategies.find((s) => s.id === id) ?? null;
}

function newId(): string {
  return 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export interface SaveInput {
  id?: string;
  name: string;
  kind: StrategyKind;
  contract: string;
  interval: string;
  spec?: StrategySpec | null;
  prompt?: string | null;
}

/**
 * 存一条策略（新建或更新）。
 *
 * 更新时如果规则内容变了（spec 或 prompt 不同），上一次的回测结论作废 ——
 * 那条结论对应的是旧规则。只改名字不算改规则，结论保留。
 */
export function saveStrategy(input: SaveInput): SavedStrategy {
  const lib = readLibrary();
  const now = Date.now();
  const kind: StrategyKind = input.kind === 'prompt' ? 'prompt' : 'rule';
  const prompt = kind === 'prompt' ? String(input.prompt ?? '').trim() : null;
  const spec = kind === 'rule' ? (input.spec ?? null) : null;

  if (kind === 'prompt' && !prompt) {
    throw new Error('提示词策略必须有一段指令');
  }
  if (kind === 'rule' && (!spec || !Array.isArray(spec.entry) || spec.entry.length === 0)) {
    throw new Error('规则策略至少要有一条入场条件');
  }

  const existing = input.id ? lib.strategies.find((s) => s.id === input.id) : undefined;
  if (existing) {
    const rulesChanged = existing.kind !== kind
      || JSON.stringify(existing.spec) !== JSON.stringify(spec)
      || (existing.prompt ?? '') !== (prompt ?? '');
    existing.name = input.name;
    existing.kind = kind;
    existing.contract = input.contract;
    existing.interval = input.interval;
    existing.spec = spec;
    existing.prompt = prompt;
    existing.updatedAt = now;
    if (rulesChanged) existing.lastRun = null;
    writeLibrary(lib);
    return existing;
  }

  const created: SavedStrategy = {
    id: newId(),
    name: input.name,
    kind,
    contract: input.contract,
    interval: input.interval,
    spec,
    prompt,
    createdAt: now,
    updatedAt: now,
    lastRun: null,
  };
  lib.strategies.push(created);
  writeLibrary(lib);
  return created;
}

/**
 * 改名。
 *
 * 单独一个动作而不是走 saveStrategy：改名不该要求调用方重新提交整份策略，
 * 也不该让"改个名字"和"改了规则"共用一条路径 —— 后者会把回测结论清掉，
 * 而改名显然不该清。
 */
export function renameStrategy(id: string, name: string): SavedStrategy | null {
  const lib = readLibrary();
  const s = lib.strategies.find((x) => x.id === id);
  if (!s) return null;
  const clean = name.trim();
  if (!clean) throw new Error('名字不能为空');
  s.name = clean.slice(0, 60);
  s.updatedAt = Date.now();
  writeLibrary(lib);
  return s;
}

export function deleteStrategy(id: string): boolean {
  const lib = readLibrary();
  const before = lib.strategies.length;
  lib.strategies = lib.strategies.filter((s) => s.id !== id);
  if (lib.strategies.length === before) return false;
  writeLibrary(lib);
  return true;
}

/** 记下一条策略的回测结论 */
export function recordRun(id: string, result: BacktestResult, verdict: {
  passed: boolean;
  failed: string[];
  enoughSample: boolean;
  contract: string;
  interval: string;
}): SavedStrategy | null {
  const lib = readLibrary();
  const s = lib.strategies.find((x) => x.id === id);
  if (!s) return null;
  s.lastRun = {
    at: Date.now(),
    contract: verdict.contract,
    interval: verdict.interval,
    passed: verdict.passed,
    failed: verdict.failed,
    expectancyPct: Number(result.stats.expectancyPct.toFixed(4)),
    trades: result.stats.trades,
    payoff: Number(result.stats.payoff.toFixed(3)),
    maxDrawdownPct: Number(result.stats.maxDrawdownPct.toFixed(2)),
    enoughSample: verdict.enoughSample,
  };
  writeLibrary(lib);
  return s;
}
