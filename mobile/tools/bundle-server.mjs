import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUpdateToken, warnMissingToken } from '../../tools/update-token.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const repo = resolve(mobile, '..');
const outDir = resolve(repo, 'web/dist/nodejs');

mkdirSync(outDir, { recursive: true });

/**
 * 和桌面端一样，版本号和更新令牌在构建时写进服务端产物。
 *
 * 版本号取 mobile/package.json；发版时它要和 android/app/build.gradle 的
 * versionName 一起改 —— 更新检查比的是这里，安装器认的是 gradle 那个。
 */
const version = JSON.parse(readFileSync(resolve(mobile, 'package.json'), 'utf8')).version;
const updateToken = readUpdateToken(repo);
warnMissingToken(updateToken);
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
  define: {
    __XF_VERSION__: JSON.stringify(version),
    __XF_UPDATE_TOKEN__: JSON.stringify(updateToken),
  },
});

copyFileSync(resolve(mobile, 'nodejs/index.js'), resolve(outDir, 'index.js'));
const packageJson = JSON.parse(readFileSync(resolve(mobile, 'nodejs/package.json'), 'utf8'));
writeFileSync(resolve(outDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
console.log('手机端 Node 服务已打包到 web/dist/nodejs/');
