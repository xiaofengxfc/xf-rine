#!/usr/bin/env node
/**
 * 跑 Binance Vision 逐笔聚合，优先用 sidecar/.venv 里的 Python。
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
const script = join(ROOT, 'sidecar', 'scripts', 'fetch_agg_trades.py');
const args = process.argv.slice(2).filter((a) => a !== '--');
const r = spawnSync(python, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
if (r.error) {
  console.error('启动 ' + python + ' 失败：' + r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
