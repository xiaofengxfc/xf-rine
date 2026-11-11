/**
 * cap sync 之后的收尾。
 *
 * 以前这一步做的是「把 Node 运行时的原生插件挪到短路径上，再给原生库加载加兜底」——
 * 那是为内置服务端准备的。手机端现在只连电脑，APK 里不再有 Node 运行时，
 * 这个脚本只剩一件事：确认要打进包里的页面是真的存在。
 *
 * 留着这个文件而不是删掉 prepare 这一步，是因为打包脚本里它是一道检查 ——
 * web/dist 忘了构建时，apt 打包会在最后一步成功产出一个「打开就白屏」的 APK。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const repo = resolve(mobile, '..');
const dist = resolve(repo, 'web/dist');

if (!existsSync(resolve(dist, 'index.html'))) {
  console.error('web/dist 里没有 index.html —— 先在仓库根目录跑 pnpm -F web build，再打 APK');
  process.exit(1);
}

// 内置服务端那套已经去掉了：dist 里要是还留着一份旧产物，说明打包前没重新构建，
// 那个 nodejs 目录会被原样塞进 APK，白占几十兆
if (existsSync(resolve(dist, 'nodejs'))) {
  console.warn('web/dist/nodejs 还在（内置服务端的旧产物），重新构建一次页面就没了');
}

const androidDir = resolve(mobile, 'android');
const settings = resolve(androidDir, 'capacitor.settings.gradle');
if (existsSync(settings)) {
  const text = readFileSync(settings, 'utf8');
  if (/capacitor-nodejs/.test(text)) {
    console.error('capacitor.settings.gradle 里还挂着 Node 运行时插件：先 pnpm -F mobile sync，再删掉 android/plugins 里的旧副本');
    process.exit(1);
  }
}

console.log('页面产物齐全，手机端只连电脑，包里没有 Node 运行时');
