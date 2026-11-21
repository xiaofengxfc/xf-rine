/**
 * 确认 APK 页面、Node 服务和原生运行时都已准备好。
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const repo = resolve(mobile, '..');
const dist = resolve(repo, 'web/dist');
const require_ = createRequire(resolve(mobile, 'package.json'));

if (!existsSync(resolve(dist, 'index.html'))) {
  console.error('web/dist 里没有 index.html —— 先在仓库根目录跑 pnpm -F web build，再打 APK');
  process.exit(1);
}

for (const file of ['index.js', 'server.js', 'package.json']) {
  if (!existsSync(resolve(dist, 'nodejs', file))) {
    console.error(`web/dist/nodejs/${file} 不存在 —— 先在仓库根目录运行 pnpm pack:android`);
    process.exit(1);
  }
}

const androidDir = resolve(mobile, 'android');
const settings = resolve(androidDir, 'capacitor.settings.gradle');
if (!existsSync(settings)) {
  console.error('找不到 capacitor.settings.gradle —— 先运行 pnpm -F mobile sync');
  process.exit(1);
}

const pluginDir = dirname(require_.resolve('@capawesome/capacitor-nodejs/package.json'));
if (!existsSync(resolve(pluginDir, 'android/build.gradle'))) {
  console.error('Node 运行时插件缺少 Android 工程：' + pluginDir);
  process.exit(1);
}

const pluginTarget = resolve(androidDir, 'plugins/capacitor-nodejs');
rmSync(pluginTarget, { recursive: true, force: true });
cpSync(pluginDir, pluginTarget, {
  recursive: true,
  filter: (source) => !/[\\/](node_modules|dist|scripts|Package\.swift)[\\/]?$/.test(source.replace(pluginDir, '')),
});

const original = readFileSync(settings, 'utf8');
const patched = original.replace(
  /project\(':capawesome-capacitor-nodejs'\)\.projectDir = new File\('[^']+'\)/,
  "project(':capawesome-capacitor-nodejs').projectDir = new File('plugins/capacitor-nodejs/android')",
);
if (patched === original && !original.includes('plugins/capacitor-nodejs/android')) {
  console.error('capacitor.settings.gradle 里没找到 Node 运行时插件条目，先检查 cap sync 输出');
  process.exit(1);
}
writeFileSync(settings, patched, 'utf8');
console.log('APK 页面、本机 Node 服务和原生运行时插件已准备好');
