
/**
 * 策略库。
 *
 * 在回测研究台里编出来的策略存这里，AI 交易那边从里面挑一条来用。
 *
 * 为什么要"存"而不是"现拉现用"：一条策略只有在回测里过了判定（样本外期望为正、
 * 笔数够、回撤可控、成本翻倍仍为正）才值得拿去实盘。库里记着它最后一次回测的结论，
 * AI 交易页就能把"你选的这条策略，上次回测是达标 / 不达标"直接摆在开关旁边 ——
 * 让人在开之前看见这一点，比开完再说有用得多。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_DIR } from '../config.js';
import type { StrategySpec } from './backtest.js';
import type { BacktestResult } from './backtest.js';

export const LIBRARY_PATH = join(HOME_DIR, 'quant-strategies.json');

export interface SavedStrategy {
  id: string;
  name: string;
  /** 存下来的那一刻是什么合约周期 */
  contract: string;
  interval: string;
  spec: StrategySpec;
  createdAt: number;
  updatedAt: number;
  /**
   * 最后一次回测的结论。null 表示还没跑过。
   * 只记结论和关键数，不记整条权益曲线（那个有几百个点，存进库里没意义）。
   */
  lastRun: {
    at: number;
    passed: boolean;
    failed: string[];
    expectancyPct: number;
    trades: number;
    payoff: number;
    maxDrawdownPct: number;
    /** 样本量够不够。不够的话上面的数都不能当结论 */
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

/** 存一条新策略。name 重复不拦 —— 允许同名，靠 id 区分，界面上显示创建时间 */
export function saveStrategy(input: {
  id?: string;
  name: string;
  contract: string;
  interval: string;
  spec: StrategySpec;
}): SavedStrategy {
  const lib = readLibrary();
  const now = Date.now();
  const existing = input.id ? lib.strategies.find((s) => s.id === input.id) : undefined;
  if (existing) {
    existing.name = input.name;
    existing.contract = input.contract;
    existing.interval = input.interval;
    existing.spec = input.spec;
    existing.updatedAt = now;
    // 改了规则，上一次的回测结论就作废：那条结论对应的是旧规则
    existing.lastRun = null;
    writeLibrary(lib);
    return existing;
  }
  const created: SavedStrategy = {
    id: newId(),
    name: input.name,
    contract: input.contract,
    interval: input.interval,
    spec: input.spec,
    createdAt: now,
    updatedAt: now,
    lastRun: null,
  };
  lib.strategies.push(created);
  writeLibrary(lib);
  return created;
}

export function deleteStrategy(id: string): boolean {
  const lib = readLibrary();
  const before = lib.strategies.length;
  lib.strategies = lib.strategies.filter((s) => s.id !== id);
  if (lib.strategies.length === before) return false;
  writeLibrary(lib);
  return true;
}

/** 记下一条策略的回测结论。页面跑完回测时调用 */
export function recordRun(id: string, result: BacktestResult, verdict: {
  passed: boolean;
  failed: string[];
  enoughSample: boolean;
}): SavedStrategy | null {
  const lib = readLibrary();
  const s = lib.strategies.find((x) => x.id === id);
  if (!s) return null;
  s.lastRun = {
    at: Date.now(),
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
