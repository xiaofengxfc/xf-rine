/**
 * 把 sidecar 打成可执行文件（PyInstaller onedir）。
 *
 * 用法：node sidecar/tools/build-exe.mjs
 * 产物：sidecar/dist/xfrine-sidecar/xfrine-sidecar.exe（Windows）
 *
 * 为什么要打包：桌面安装版不能要求用户自己装 Python。打出来的目录由
 * electron-builder 整体拷进 resources/sidecar，桌面端启动时用 XFRINE_SIDECAR 指过去。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const sidecar = join(root, 'sidecar');
const isWin = process.platform === 'win32';
const py = (process.env.XFRINE_PYTHON ?? '').trim()
  || join(sidecar, '.venv', isWin ? 'Scripts/python.exe' : 'bin/python');

function run(args, opts = {}) {
  const r = spawnSync(py, args, { cwd: sidecar, stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(py)) {
  console.error('找不到 Python 解释器：' + py);
  console.error('先建虚拟环境：python -m venv sidecar/.venv && sidecar/.venv/Scripts/pip install -r sidecar/requirements.txt');
  process.exit(1);
}

// PyInstaller 装在虚拟环境里的话最好；没有就装一次（离线环境会失败，那就手动装）
const has = spawnSync(py, ['-m', 'PyInstaller', '--version'], { stdio: 'ignore' });
if (has.status !== 0) {
  console.log('[sidecar] 没装 PyInstaller，先装一次…');
  run(['-m', 'pip', 'install', 'pyinstaller']);
}

console.log('[sidecar] 开始打包（onedir）…');
run(['-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', 'dist', '--workpath', 'build', 'xfrine-sidecar.spec']);

const exeName = isWin ? 'xfrine-sidecar.exe' : 'xfrine-sidecar';
const out = join(sidecar, 'dist', 'xfrine-sidecar', exeName);
if (!existsSync(out)) {
  console.error('打包结束但没找到产物：' + out);
  process.exit(1);
}
console.log('[sidecar] 产物：' + out);
