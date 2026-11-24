#!/usr/bin/env node
/**
 * 一条命令跑完所有「不需要交易所、不需要密钥、不需要网络」的体检脚本。
 *
 * 为什么要这个入口：
 * 仓库里散着三十多个 check-*.ts / check_*.py，以前要照着 README 一条一条敲。
 * 敲不全，就等于没测 —— 这次重构要靠它们兜底，所以先有一个能一把跑完、
 * 退出码可信的入口，CI 才有东西可跑。
 *
 * 只收离线的那一部分：要交易所行情、要密钥、要 Python 数值环境的脚本不在这里，
 * 它们仍然是需要时手工跑（见 README 的「体检命令」一节）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(ROOT, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** 每一项：怎么跑、跑哪个文件、大概多久算超时 */
const CHECKS = [
  // ---- server：纯逻辑，不碰网络 ----
  { group: 'server', name: 'config-keys', file: 'server/scripts/check-config-keys.ts' },
  { group: 'server', name: 'errors', file: 'server/scripts/check-errors.ts' },
  { group: 'server', name: 'params', file: 'server/scripts/check-params.ts' },
  { group: 'server', name: 'instrument', file: 'server/scripts/check-instrument.ts' },
  { group: 'server', name: 'http-security', file: 'server/scripts/check-http-security.ts' },
  { group: 'server', name: 'ws-route', file: 'server/scripts/check-ws-route.ts' },
  { group: 'server', name: 'daily-pnl', file: 'server/scripts/check-daily-pnl.ts' },
  { group: 'server', name: 'bitget-mapping', file: 'server/scripts/check-bitget-mapping.ts' },
  { group: 'server', name: 'update', file: 'server/scripts/check-update.ts' },
  { group: 'server', name: 'prompt-baseline', file: 'server/scripts/check-prompt-baseline.ts' },
  { group: 'server', name: 'quant', file: 'server/scripts/check-quant.ts' },
  // 起一个本地假模型服务，全程回环
  { group: 'server', name: 'ai', file: 'server/scripts/check-ai.ts', timeoutMs: 180_000 },
  // 只绑 127.0.0.1 的若干端口，慢一些
  { group: 'server', name: 'ws-failover', file: 'server/scripts/check-ws-failover.ts', timeoutMs: 180_000 },

  // ---- web：纯函数与图表几何，不碰 DOM、不碰接口 ----
  { group: 'web', name: 'units', file: 'web/scripts/check-units.ts' },
  { group: 'web', name: 'sizing', file: 'web/scripts/check-sizing.ts' },
  { group: 'web', name: 'paint', file: 'web/scripts/check-paint.ts' },
  { group: 'web', name: 'level-lines', file: 'web/scripts/check-level-lines.ts' },
  { group: 'web', name: 'chart-price-lines', file: 'web/scripts/check-chart-price-lines.ts' },
  { group: 'web', name: 'chart-tap', file: 'web/scripts/check-chart-tap.ts' },
  { group: 'web', name: 'position-pnl', file: 'web/scripts/check-position-pnl.ts' },
  { group: 'web', name: 'protection', file: 'web/scripts/check-protection.ts' },
  { group: 'web', name: 'update-flow', file: 'web/scripts/check-update-flow.ts' },
  { group: 'web', name: 'viewport', file: 'web/scripts/check-viewport.ts' },
  { group: 'web', name: 'liquidation', file: 'web/scripts/check-liquidation.ts' },
  { group: 'web', name: 'pattern-index', file: 'web/scripts/check-pattern-index.ts' },
  { group: 'web', name: 'patterns', file: 'web/scripts/check-patterns.ts', timeoutMs: 180_000 },

  // ---- sidecar：HTTP 契约，pipeline 被打了桩，不需要 numpy ----
  { group: 'sidecar', name: 'http-api', file: 'sidecar/scripts/check_http_api.py', lang: 'python' },
];

const DEFAULT_TIMEOUT_MS = 120_000;
/** 失败时最多回放多少行输出：够看出是哪一条断言，又不至于把整屏刷满 */
const TAIL_LINES = 40;

const args = process.argv.slice(2);
const only = valueOf('--only');
const groupFilter = valueOf('--group');
const listOnly = args.includes('--list');

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : '';
}

/** 找 Python：Windows 上是 python，其他平台通常是 python3 */
function findPython() {
  for (const cmd of ['python3', 'python']) {
    const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return cmd;
  }
  return null;
}

/**
 * 跑一项。超时用 spawn 自带的 timeout —— 子进程到点自己被杀，
 * 这里不用自己记时，也就不会出现「定时器没清干净把进程钩住」。
 */
function runOne(check, python) {
  if (check.lang === 'python' && !python) {
    return Promise.resolve({ ok: false, skipped: true, detail: '本机没有 python，跳过', output: '', ms: 0 });
  }
  const abs = join(ROOT, check.file);
  if (!existsSync(abs)) {
    return Promise.resolve({ ok: false, detail: '文件不存在：' + check.file, output: '', ms: 0 });
  }
  const cmd = check.lang === 'python' ? python : process.execPath;
  const cmdArgs = check.lang === 'python' ? [abs] : [TSX_CLI, abs];
  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise((done) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (err) => {
      done({ ok: false, detail: '启动失败：' + err.message, output, ms: Date.now() - startedAt });
    });
    child.on('close', (code, signal) => {
      const timedOut = signal === 'SIGKILL' && child.killed;
      done({
        ok: code === 0,
        detail: code === 0 ? '' : (timedOut ? '超时被杀' : '退出码 ' + code),
        output,
        ms: Date.now() - startedAt,
      });
    });
  });
}

function tail(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.slice(-TAIL_LINES).join('\n');
}

async function main() {
  let selected = CHECKS;
  if (groupFilter) selected = selected.filter((c) => c.group === groupFilter);
  if (only) selected = selected.filter((c) => c.name.includes(only) || c.file.includes(only));

  if (listOnly) {
    for (const c of selected) console.log(c.group.padEnd(8) + c.name.padEnd(18) + c.file);
    return 0;
  }

  if (!existsSync(TSX_CLI)) {
    console.error('找不到 tsx（' + TSX_CLI + '）。先跑 pnpm install。');
    return 1;
  }

  const python = findPython();
  console.log('体检脚本 ' + selected.length + ' 项，离线运行' + (python ? '' : '（本机没有 python，sidecar 项会跳过）'));
  console.log('');

  const failed = [];
  const skipped = [];
  for (const check of selected) {
    process.stdout.write('  ' + check.group.padEnd(8) + check.name.padEnd(18));
    const result = await runOne(check, python);
    if (result.skipped) {
      skipped.push(check);
      console.log('跳过  ' + result.detail);
      continue;
    }
    if (result.ok) {
      console.log('✓  ' + (result.ms / 1000).toFixed(1) + 's');
      continue;
    }
    console.log('✗  ' + result.detail);
    failed.push({ check, result });
  }

  if (failed.length) {
    for (const { check, result } of failed) {
      console.log('');
      console.log('---- 失败：' + check.group + '/' + check.name + '（' + check.file + '）----');
      console.log(tail(result.output));
    }
  }

  console.log('');
  const okCount = selected.length - failed.length - skipped.length;
  console.log('通过 ' + okCount + ' / 失败 ' + failed.length + (skipped.length ? ' / 跳过 ' + skipped.length : ''));
  if (failed.length) {
    console.log('失败项：' + failed.map(({ check }) => check.group + '/' + check.name).join('、'));
    return 1;
  }
  return 0;
}

process.exitCode = await main();
