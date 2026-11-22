import { netFetch } from './net.js';

/**
 * 客户端的自动更新：查 GitHub 的 Release，挑出该装哪个包，判断要不要提示。
 *
 * 这里只管「查到什么、该不该提示」。下载和安装由客户端自己做：
 * 桌面端交给外壳（Electron 主进程），安卓交给系统浏览器。
 *
 * 版本号和令牌在打包时由 esbuild 注入；开发态用环境变量顶上：
 * XF_APP_VERSION、XF_UPDATE_TOKEN。仓库本身是私有的，匿名请求 API 只会拿到 404，
 * 所以令牌是查更新和下载安装包的前提。打包脚本从 .update-token 或环境变量读它。
 */

declare const __XF_VERSION__: string;
declare const __XF_UPDATE_TOKEN__: string;

/** 打包时注入的字符串常量。typeof 对没定义的标识符是安全的，开发态走这里不会抛。 */
function builtString(name: 'version' | 'token'): string {
  if (name === 'version') return typeof __XF_VERSION__ === 'string' ? __XF_VERSION__ : '';
  return typeof __XF_UPDATE_TOKEN__ === 'string' ? __XF_UPDATE_TOKEN__ : '';
}

/** 这份程序自己的版本号。没注入时退回环境变量，再没有就是空串 */
export const APP_VERSION = (builtString('version') || (process.env.XF_APP_VERSION ?? '')).trim();

/** 读 GitHub 的令牌。只读权限就够（Contents: Read） */
export function updateToken(): string {
  return (builtString('token') || (process.env.XF_UPDATE_TOKEN ?? '')).trim();
}

function repo(): string {
  return (process.env.XF_UPDATE_REPO ?? '').trim() || 'xiaofengxfc/xf-rine';
}

function apiBase(): string {
  return ((process.env.XF_UPDATE_API ?? '').trim() || 'https://api.github.com').replace(/\/+$/, '');
}

export type UpdatePlatform = 'win' | 'android';

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  /** GitHub 给的 sha256:<hex>。老版本上传的资源可能没有这一项 */
  digest: string;
}

export interface Release {
  version: string;
  notes: string;
  publishedAt: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: ReleaseAsset[];
}

/**
 * 版本号拆成数字段。
 *
 * 只比数字：1.2.10 必须大于 1.2.9，按字符串比会反过来。
 * 后缀（-beta.1）按预发布处理，比较时忽略 —— 客户端只装正式版。
 */
export function parseVersion(raw: string): number[] {
  const core = String(raw ?? '').trim().replace(/^v/i, '').split(/[-+]/)[0] ?? '';
  const parts = core.split('.').map((piece) => {
    const n = Number.parseInt(piece, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return parts.length ? parts : [0];
}

/** 比版本号：a 大返回 1，b 大返回 -1，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 这一条 release 里哪个资源是给这个平台用的。
 *
 * 兼容包和安装包不能混：安卓拿 Setup.exe 装不上，桌面拿 APK 也跑不起来。
 * 文件名沿用打包脚本的命名（见 electron-builder.yml 的 artifactName）。
 */
export function pickAsset(assets: ReleaseAsset[], platform: UpdatePlatform): ReleaseAsset | null {
  const pattern = platform === 'android' ? /\.apk$/i : /-Setup\.exe$/i;
  return assets.find((asset) => pattern.test(asset.name)) ?? null;
}

/**
 * 当前版本之后、能装的最新一版。
 *
 * 草稿和预发布直接跳过；没有对应平台安装包的也跳过 —— 提示了却下不了，等于没提示。
 */
export function latestFor(releases: Release[], current: string, platform: UpdatePlatform): Release | null {
  let best: Release | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    if (compareVersions(release.version, current) <= 0) continue;
    if (!pickAsset(release.assets, platform)) continue;
    if (!best || compareVersions(release.version, best.version) > 0) best = release;
  }
  return best;
}

/**
 * GitHub 返回的那一份 JSON 收成这里要的形状。
 *
 * 外部数据不能直接信：字段少一个、类型换一下，后面取 asset.id 就会炸。
 * 认不出来的条目直接丢掉，不猜。
 */
export function normalizeReleases(input: unknown): Release[] {
  if (!Array.isArray(input)) return [];
  const out: Release[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const tag = String(row.tag_name ?? '').trim();
    if (!tag) continue;
    const assets: ReleaseAsset[] = [];
    if (Array.isArray(row.assets)) {
      for (const entry of row.assets) {
        if (!entry || typeof entry !== 'object') continue;
        const asset = entry as Record<string, unknown>;
        const id = Number(asset.id);
        const name = String(asset.name ?? '').trim();
        if (!Number.isFinite(id) || id <= 0 || !name) continue;
        assets.push({
          id,
          name,
          size: Number(asset.size) > 0 ? Number(asset.size) : 0,
          digest: String(asset.digest ?? '').trim().toLowerCase(),
        });
      }
    }
    out.push({
      version: tag.replace(/^v/i, ''),
      notes: String(row.body ?? ''),
      publishedAt: String(row.published_at ?? ''),
      draft: row.draft === true,
      prerelease: row.prerelease === true,
      assets,
    });
  }
  return out;
}

/** 缓存十分钟：一次启动最多问 GitHub 一次，多次开窗口也不重复打接口 */
const CACHE_MS = 10 * 60_000;
let cache: { at: number; releases: Release[] } | null = null;
let inflight: Promise<Release[]> | null = null;

function authHeaders(accept: string): Record<string, string> {
  const token = updateToken();
  const headers: Record<string, string> = {
    accept,
    'user-agent': 'xf-rine-updater',
  };
  if (token) headers.authorization = 'Bearer ' + token;
  return headers;
}

function githubError(status: number, body: string): string {
  if (status === 401) return '更新令牌已失效，换一个再打包';
  if (status === 403) return '更新接口被限流或令牌权限不够';
  if (status === 404) return '这个令牌看不到更新仓库（仓库是不是改了名，或者令牌没有读权限）';
  return '更新接口回了 HTTP ' + status + (body ? '：' + body.slice(0, 160) : '');
}

async function loadReleases(): Promise<Release[]> {
  if (!updateToken()) throw new Error('UPDATE_TOKEN_MISSING');
  const res = await netFetch(
    apiBase() + '/repos/' + repo() + '/releases?per_page=10',
    { headers: authHeaders('application/vnd.github+json') },
    { attemptMs: 20_000 },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(githubError(res.status, text));
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('更新接口返回的不是 JSON');
  }
  return normalizeReleases(parsed);
}

/** 最近十次发布。失败时保留上一次拿到的结果，网络抖一下不该让页面以为「没有更新」 */
async function cachedReleases(): Promise<Release[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.releases;
  if (!inflight) {
    inflight = loadReleases()
      .then((list) => {
        cache = { at: Date.now(), releases: list };
        return list;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (err) {
    if (cache) return cache.releases;
    throw err;
  }
}

export interface UpdateAsset {
  name: string;
  size: number;
  digest: string;
}

export interface UpdateRelease {
  version: string;
  notes: string;
  publishedAt: string;
  asset: UpdateAsset;
}

export interface UpdateCheck {
  /** 有没有配更新令牌。没配时客户端什么都不显示 */
  enabled: boolean;
  /** 这份程序自己的版本 */
  current: string;
  /** 比当前新、且能装的版本 */
  latest: UpdateRelease | null;
  /** 当前这一版的更新说明。刚升级完要弹的就是它 */
  self: { version: string; notes: string } | null;
  error?: string;
}

function toRelease(release: Release, platform: UpdatePlatform): UpdateRelease | null {
  const asset = pickAsset(release.assets, platform);
  if (!asset) return null;
  return {
    version: release.version,
    notes: release.notes,
    publishedAt: release.publishedAt,
    asset: { name: asset.name, size: asset.size, digest: asset.digest },
  };
}

/**
 * 要不要提示更新，以及提示什么。
 *
 * releases 可以注入，测试就不必碰网络。
 */
export async function checkUpdate(input: {
  current: string;
  platform: UpdatePlatform;
  releases?: Release[];
  token?: string;
}): Promise<UpdateCheck> {
  const current = input.current.trim();
  const enabled = Boolean((input.token ?? updateToken()).trim()) || input.releases !== undefined;
  const base: UpdateCheck = { enabled, current, latest: null, self: null };
  if (!enabled) {
    return { ...base, error: 'UPDATE_TOKEN_MISSING' };
  }

  let releases: Release[];
  try {
    releases = input.releases ?? (await cachedReleases());
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const currentRelease = releases.find((release) => compareVersions(release.version, current) === 0) ?? null;
  const latest = latestFor(releases, current, input.platform);
  return {
    ...base,
    latest: latest ? toRelease(latest, input.platform) : null,
    self: currentRelease ? { version: currentRelease.version, notes: currentRelease.notes } : null,
  };
}

/**
 * 打开某个版本的安装包，返回上游响应和资源信息。
 *
 * 令牌只在服务端用：客户端要下载时打到 /api/update/download，
 * 由这里带着令牌取回来再转发。安装包一百多兆，所以不设短超时 ——
 * 由调用方在客户端断开时中止。
 */
export async function openAsset(input: {
  version: string;
  platform: UpdatePlatform;
  signal?: AbortSignal;
  releases?: Release[];
}): Promise<{ asset: ReleaseAsset; upstream: Awaited<ReturnType<typeof netFetch>> } | null> {
  if (!updateToken()) throw new Error('UPDATE_TOKEN_MISSING');
  const releases = input.releases ?? (await cachedReleases());
  const release = releases.find((item) => compareVersions(item.version, input.version) === 0) ?? null;
  if (!release) return null;
  const asset = pickAsset(release.assets, input.platform);
  if (!asset) return null;

  const upstream = await netFetch(
    apiBase() + '/repos/' + repo() + '/releases/assets/' + asset.id,
    { headers: authHeaders('application/octet-stream'), signal: input.signal },
    // 慢网下一百多兆要几十分钟。给整段下载留足时间，断开由客户端那边触发
    { attemptMs: 30 * 60_000 },
  );
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    throw new Error(githubError(upstream.status, body));
  }
  return { asset, upstream };
}
