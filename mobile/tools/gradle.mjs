/**
 * 用仓库自带的 JDK / Android SDK 跑 gradlew。
 *
 * 为什么不直接 `cd android && gradlew.bat assembleRelease`：
 *   1. gradlew 只认 JAVA_HOME（或者 PATH 上的 java）。这台机器两样都没有，
 *      但仓库里明明带着 .toolchain/jdk —— 于是脚本报 "JAVA_HOME is not set"，
 *      看着像打包坏了，其实只是没把 JDK 指给别人看。
 *   2. SDK 路径写在 android/local.properties 里，而那个文件不进版本库
 *      （.gitignore 里就有它）。换台机器重新 clone 出来，Gradle 会报
 *      "SDK location not found"，同样不是代码的问题。
 *
 * 顺序按「用户已经说过的优先，仓库自带的兜底」来，找不到就直说要什么，
 * 不让人对着一行 Gradle 报错猜。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const repo = resolve(mobile, '..');
const androidDir = join(mobile, 'android');

const isWin = process.platform === 'win32';
const javaBin = isWin ? 'bin/java.exe' : 'bin/java';

/** 一个目录像不像 JDK：要有 bin/java，还得有 lib（只放个 javac 的 JRE 不算） */
function isJdk(dir) {
  if (!dir || !existsSync(dir)) return false;
  return existsSync(join(dir, javaBin)) && existsSync(join(dir, 'lib'));
}

function findJdk() {
  const tried = [];
  const candidates = [
    process.env.JAVA_HOME,
    join(repo, '.toolchain/jdk'),
    // Android Studio 自带的 JBR，装了 Studio 的机器直接能用
    'C:\\Program Files\\Android\\Android Studio\\jbr',
  ];
  for (const c of candidates) {
    if (!c) continue;
    tried.push(c);
    if (isJdk(c)) return { home: c, tried };
  }
  return { home: null, tried };
}

/** local.properties 里现在写的是哪个 SDK（没有就返回空串） */
function sdkFromLocalProperties() {
  const file = join(androidDir, 'local.properties');
  if (!existsSync(file)) return '';
  const m = /^sdk\.dir=(.*)$/m.exec(readFileSync(file, 'utf8'));
  if (!m) return '';
  // properties 文件里反斜杠是转义符，Windows 路径得写成 D:\\a\\b
  return m[1].trim().replace(/\\\\/g, '\\');
}

function findSdk() {
  const tried = [];
  const fromProps = sdkFromLocalProperties();
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    fromProps,
    join(repo, '.toolchain/sdk'),
  ];
  for (const c of candidates) {
    if (!c) continue;
    tried.push(c);
    // 认 platforms 目录：有它才是真的 SDK，空壳子目录不算
    if (existsSync(join(c, 'platforms'))) return { dir: c, fromProps, tried };
  }
  return { dir: null, fromProps, tried };
}

const jdk = findJdk();
if (!jdk.home) {
  console.error('找不到 JDK。三种办法任选一种：');
  console.error('  1. 设置 JAVA_HOME 指向 JDK 目录（JDK 17 及以上）；');
  console.error('  2. 把 JDK 解到 ' + join(repo, '.toolchain/jdk') + '；');
  console.error('  3. 装 Android Studio，用它自带的 jbr。');
  console.error('找过的地方：' + jdk.tried.join(' | '));
  process.exit(1);
}

const sdk = findSdk();
if (!sdk.dir) {
  console.error('找不到 Android SDK。两种办法任选一种：');
  console.error('  1. 设置 ANDROID_HOME 指向 SDK 目录（要有 platforms/）；');
  console.error('  2. 把 SDK 解到 ' + join(repo, '.toolchain/sdk') + '。');
  console.error('找过的地方：' + sdk.tried.join(' | '));
  process.exit(1);
}

// local.properties 不进版本库：没有就写一份，写的不是当前 SDK 就改过来
if (sdk.dir !== sdk.fromProps) {
  const escaped = sdk.dir.replace(/\\/g, '\\\\');
  writeFileSync(join(androidDir, 'local.properties'), 'sdk.dir=' + escaped + '\n', 'utf8');
  console.log('已把 Android SDK 写进 android/local.properties：' + sdk.dir);
}

console.log('JDK        ' + jdk.home);
console.log('Android SDK ' + sdk.dir);
console.log('Gradle 任务 ' + (process.argv.slice(2).join(' ') || 'assembleRelease'));

const gradlew = isWin ? 'gradlew.bat' : './gradlew';
const tasks = process.argv.slice(2);
const args = tasks.length > 0 ? tasks : ['assembleRelease'];

const r = spawnSync(gradlew, args, {
  cwd: androidDir,
  stdio: 'inherit',
  env: { ...process.env, JAVA_HOME: jdk.home, ANDROID_HOME: sdk.dir },
  shell: isWin,
});
process.exit(r.status ?? 1);
