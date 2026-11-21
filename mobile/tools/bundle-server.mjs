import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
  external: ['bufferutil', 'utf-8-validate', 'bridge'],
  logOverride: { 'empty-import-meta': 'silent' },
});

copyFileSync(resolve(mobile, 'nodejs/index.js'), resolve(outDir, 'index.js'));
const packageJson = JSON.parse(readFileSync(resolve(mobile, 'nodejs/package.json'), 'utf8'));
writeFileSync(resolve(outDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
console.log('手机端 Node 服务已打包到 web/dist/nodejs/');
