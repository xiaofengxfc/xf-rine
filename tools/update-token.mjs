import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 打包时可选注入的 GitHub 只读令牌。
 *
 * 仓库是公开的，平时不需要令牌：客户端匿名查 Release 就够。
 * 这个口子是给私有 fork 留的 —— 想指向一个私有仓库时，打包前设 XF_UPDATE_TOKEN
 * （细粒度、只读 Contents），令牌会被写进服务端产物，运行时不再读外部文件。
 * 注意它会跟着安装包一起分发：拿到安装包的人能解出来，所以只能用只读令牌。
 *
 * 来源只有环境变量。没有就返回空串，请求走匿名。
 */
export function readUpdateToken(repoRoot) {
  const fromEnv = (process.env.XF_UPDATE_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  // 兼容一下以前的本地文件写法，但不再提示：公开仓库用不上它
  const file = resolve(repoRoot, '.update-token');
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}
