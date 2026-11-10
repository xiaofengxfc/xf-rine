/**
 * 给手机端打服务端。
 *
 * 和桌面端同一个入口、同一份代码，区别只有三处：
 *   - 目标运行时是 nodejs-mobile 里的 Node 18（不是 Electron 的 Node 22）
 *   - 产物落在 web/dist/nodejs/ ，Capacitor 会把它当资源打进 APK，
 *     运行时由插件拷到 App 私有目录再执行
 *   - 入口不是 server.cjs，而是上面那个 index.js（先定数据目录，再起服务）
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const repo = resolve(mobile, '..');
const outDir = resolve(repo, 'web/dist/nodejs');

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(repo, 'server/src/index.ts')],
  outfile: resolve(outDir, 'server.js'),
  bundle: true,
  platform: 'node',
  // nodejs-mobile 带的是 Node 18
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
  external: ['bufferutil', 'utf-8-validate', 'bridge'],
  logOverride: { 'empty-import-meta': 'silent' },
});

// 入口和 package.json 一起放进去：插件按 package.json 的 main 找脚本
copyFileSync(resolve(mobile, 'nodejs/index.js'), resolve(outDir, 'index.js'));
const pkg = JSON.parse(readFileSync(resolve(mobile, 'nodejs/package.json'), 'utf8'));
writeFileSync(resolve(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

console.log('手机端服务端已就绪：web/dist/nodejs/');
