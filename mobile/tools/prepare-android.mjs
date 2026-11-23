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

/**
 * 版本号对不上，装出来的包就是坏的。
 *
 * 两处各写一份，从来就容易只改一处：
 *   - mobile/package.json  → 打进 server.js 的 __XF_VERSION__，服务端拿它判断「有没有新版」；
 *   - app/build.gradle     → 安装器认的 versionName，系统靠它决定能不能覆盖安装。
 *
 * 只改 json：App 自己觉得是 1.2.6（于是不再提示更新），可系统看到的还是 1.2.5，
 * 下一个包装上去又被判成同一版 —— 用户会看到「有新版但点不动」。
 * 只改 gradle：反过来，装完之后服务端还报旧版本，下次启动继续提示更新。
 * 所以这里直接拦下，别等装到手机上才发现。
 */
const appVersion = JSON.parse(readFileSync(resolve(mobile, 'package.json'), 'utf8')).version;
const gradleText = readFileSync(resolve(androidDir, 'app/build.gradle'), 'utf8');
const gradleVersion = (/versionName\s+"([^"]+)"/.exec(gradleText) ?? [])[1] ?? '';
if (gradleVersion !== appVersion) {
  console.error('版本号不一致：mobile/package.json 是 ' + appVersion
    + '，android/app/build.gradle 的 versionName 是 ' + (gradleVersion || '（没找到）')
    + '。两处要一起改，否则装上去的包会一直提示更新，或者从来不提示。');
  process.exit(1);
}

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
