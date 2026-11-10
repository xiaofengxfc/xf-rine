/**
 * 把 Node 运行时的原生插件挪到短路径上，再改掉 settings.gradle 指向。
 *
 * 为什么要这一步：那个插件里有一段 C++（桥接 Node 运行时用），CMake 生成的中间文件
 * 会把源码的绝对路径整个镜像进目录名。pnpm 装出来的路径本来就长：
 *
 *   node_modules/.pnpm/@capawesome+capacitor-nodejs@0.2.0_@capacitor+core@8.6.0/node_modules/...
 *
 * 再叠上 .cxx/RelWithDebInfo/xxx/arm64-v8a/CMakeFiles/...，一条路径三百多个字符，
 * Windows 上直接 mkdir 失败 —— 报错是 "ninja: error: mkdir(...): No such file or directory"，
 * 看着像权限问题，其实只是路径太长。
 *
 * 所以复制一份到 android/plugins/ 下面（一共 1 MB 出头），路径短到两百字符以内。
 * 复制是每次打包都做的，原件不动，升级插件也不会漏。
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = resolve(here, '../android');
const require_ = createRequire(import.meta.url);
const target = join(androidDir, 'plugins/capacitor-nodejs');

const pluginDir = dirname(require_.resolve('@capawesome/capacitor-nodejs/package.json'));
if (!existsSync(join(pluginDir, 'android/build.gradle'))) {
  console.error('找不到 Node 运行时插件的 android 目录：' + pluginDir);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(pluginDir, target, {
  recursive: true,
  // 只搬打包要用的东西：android 工程、iOS 那份 C++ 和内置模块资源（CMakeLists 和
  // assets.srcDirs 都按相对路径引用它们），dist/文档/TS 定义都不用
  filter: (src) => !/[\\/](node_modules|dist|scripts|Package\.swift)[\\/]?$/.test(src.replace(pluginDir, '')),
});

/**
 * 原生库加载失败别让 App 直接退出。
 *
 * 插件原来的写法是静态块里直接 System.loadLibrary，失败抛的是 ExceptionInInitializerError ——
 * 那是 Error 不是 Exception，Capacitor 的 Plugin.load() 里接不住，进程当场结束。
 * 用户看到的就是「启动闪退」，连一句提示都没有。
 *
 * 这里把原因存下来，等 start() 时当作普通错误返回给页面，页面能把话说明白。
 */
const nodejsJava = join(target, 'android/src/main/java/io/capawesome/capacitorjs/plugins/nodejs/Nodejs.java');
const javaSrc = readFileSync(nodejsJava, 'utf8');
const loadBlock = `    static {
        System.loadLibrary("node");
        System.loadLibrary("capacitor-nodejs");
    }`;
if (!javaSrc.includes(loadBlock)) {
  console.error('Nodejs.java 里的静态加载块和预期不一样，插件可能升级了，先看一眼再改本脚本');
  process.exit(1);
}
const guardedLoad = `    /** 原生库加载失败时记下原因（null 表示正常） */
    static String LOAD_ERROR = null;

    static {
        try {
            System.loadLibrary("node");
            System.loadLibrary("capacitor-nodejs");
        } catch (Throwable t) {
            LOAD_ERROR = t.getClass().getSimpleName() + (t.getMessage() == null ? "" : ": " + t.getMessage());
            android.util.Log.e("Nodejs", "原生运行时加载失败", t);
        }
    }`;
let patchedJava = javaSrc.replace(loadBlock, guardedLoad);

const startHead = `        if (started) {
            callback.error(CustomExceptions.NODE_ALREADY_RUNNING);
            return;
        }`;
if (!patchedJava.includes(startHead)) {
  console.error('Nodejs.java 的 start() 和预期不一样，先看一眼再改本脚本');
  process.exit(1);
}
patchedJava = patchedJava.replace(
  startHead,
  startHead + `
        if (LOAD_ERROR != null) {
            callback.error(new Exception("原生运行时加载失败：" + LOAD_ERROR));
            return;
        }`,
);
writeFileSync(nodejsJava, patchedJava, 'utf8');
console.log('已给原生库加载加上兜底（失败时报给页面，不再闪退）');

// cap sync 每次都会重写这个文件，所以这里改的是它最后一次的产物
const settingsFile = join(androidDir, 'capacitor.settings.gradle');
const original = readFileSync(settingsFile, 'utf8');
const patched = original.replace(
  /project\(':capawesome-capacitor-nodejs'\)\.projectDir = new File\('[^']+'\)/,
  "project(':capawesome-capacitor-nodejs').projectDir = new File('plugins/capacitor-nodejs/android')",
);
if (patched === original && !original.includes("plugins/capacitor-nodejs/android")) {
  console.error('capacitor.settings.gradle 里没找到 nodejs 插件那一行，插件可能没被 cap sync 识别');
  process.exit(1);
}
writeFileSync(settingsFile, patched, 'utf8');

console.log('原生插件已挪到 android/plugins/capacitor-nodejs（避开 Windows 路径长度限制）');
