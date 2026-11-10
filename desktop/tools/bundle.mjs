/**
 * 把服务端打成一个文件。
 *
 * Electron 里没法像开发时那样「有 node_modules、用 tsx 跑 TypeScript」：
 * 装完之后用户机器上只有一个 exe，源码和依赖都得先打进去。
 *
 * 产物：desktop/out/server.cjs，由 electron-builder 放进 resources/server/，
 * 主进程用 Electron 自带的 Node 去跑它（ELECTRON_RUN_AS_NODE=1），不需要用户装 Node。
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const repo = resolve(desktop, '..');

mkdirSync(resolve(desktop, 'out'), { recursive: true });

await build({
  entryPoints: [resolve(repo, 'server/src/index.ts')],
  outfile: resolve(desktop, 'out/server.cjs'),
  bundle: true,
  platform: 'node',
  // Electron 45 里是 Node 22，按它编；别让 esbuild 把现代语法往下压
  target: 'node22',
  // CJS：ELECTRON_RUN_AS_NODE 跑 .cjs 不需要再看 package.json 里的 type
  format: 'cjs',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  // ws 的两个可选原生加速模块，装不装都能跑，打包时别去找它们
  external: ['bufferutil', 'utf-8-validate'],
  // 打包成一个文件之后 import.meta 就没有了，config.ts 那边有兜底；这里把话说清楚
  logOverride: { 'empty-import-meta': 'silent' },
});

console.log('服务端已打包：desktop/out/server.cjs');
