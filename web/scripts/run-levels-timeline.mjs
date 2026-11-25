#!/usr/bin/env node
/**
 * 跑 sidecar 的关键位时间线导出，优先用 sidecar/.venv 里的 Python。
 *
 * 为什么要包一层：pnpm levels:timeline 直接写 python 时，Windows 上可能落到
 * Microsoft Store 的别名，或者系统 Python 没有 pandas/numpy。仓库已经有 venv，
 * 先用它；没有 venv 才退回 PATH 里的 python。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const venv = process.platform === 'win32'
  ? join(ROOT, 'sidecar', '.venv', 'Scripts', 'python.exe')
  : join(ROOT, 'sidecar', '.venv', 'bin', 'python');
const python = existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3');
const script = join(ROOT, 'sidecar', 'scripts', 'export_levels_timeline.py');
const args = process.argv.slice(2).filter((a) => a !== '--');
const r = spawnSync(python, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
if (r.error) {
  console.error('启动 ' + python + ' 失败：' + r.error.message);
  console.error('装好 Python 和 sidecar/.venv，或直接跑：python sidecar/scripts/export_levels_timeline.py');
  process.exit(1);
}
process.exit(r.status ?? 1);
