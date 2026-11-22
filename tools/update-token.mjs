import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 打包时注入安装包的 GitHub 只读令牌。
 *
 * 仓库是私有的，匿名请求 releases 只会拿到 404，所以客户端必须带着令牌；
 * 令牌在打包时被写进服务端产物（esbuild 的 define），运行时不再读外部文件。
 * 它**跟着安装包一起分发**，拿到安装包的人就能解出来 —— 因此只能用细粒度令牌，
 * 权限只给这一个仓库的 Contents: Read，泄露了换一个重新打包即可。
 *
 * 来源：环境变量 XF_UPDATE_TOKEN 优先，其次是仓库根目录的 .update-token（不进版本库）。
 * 两个都没有时返回空串，打出来的安装包不检查更新 —— 构建时会给一句警告。
 */
export function readUpdateToken(repoRoot) {
  const fromEnv = (process.env.XF_UPDATE_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  const file = resolve(repoRoot, '.update-token');
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 没配令牌时提醒一句：这不是错误，但打出来的包不会自动更新 */
export function warnMissingToken(token) {
  if (token) return;
  console.warn('[warn] 没有更新令牌（.update-token 或 XF_UPDATE_TOKEN），打出来的安装包不会检查更新');
  console.warn('       要开自动更新：建一个只读 Contents 的细粒度令牌，写进 .update-token 再打包');
}
