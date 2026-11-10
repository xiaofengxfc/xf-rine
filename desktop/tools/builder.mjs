/**
 * 用「真正的」Node 跑 electron-builder。
 *
 * 这台机器 PATH 上的 node 是 DSH 的 node.cmd（转发到 DSH Desktop.exe），它会把 --win --x64
 * 当成 Electron 自己的开关吃掉，electron-builder 只收到一个裸路径，报「Unknown argument: .../cli.js」。
 * 所以这里显式挑一个：XFRINE_NODE > D:\tool\node\node.exe > 当前进程（前提是它本身不是 Electron）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(pkgDir, 'package.json'));
const cli = require.resolve('electron-builder/cli.js');

const insideElectron = Boolean(process.versions.electron);
const candidates = [process.env.XFRINE_NODE, 'D:\\tool\\node\\node.exe', insideElectron ? null : process.execPath];
const node = candidates.filter(Boolean).find((p) => existsSync(p));
if (!node) {
  console.error('找不到可用的 Node：请设置 XFRINE_NODE 指向 node.exe');
  process.exit(1);
}

console.log('electron-builder 用 ' + node);
const r = spawnSync(node, [cli, '--win', '--x64', '--config', 'electron-builder.yml'], {
  cwd: pkgDir,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);