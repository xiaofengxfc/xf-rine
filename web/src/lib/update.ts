import { jget } from './api.ts';
import { apiUrl, isNative, remoteToken } from './endpoint.ts';

/**
 * 客户端更新。
 *
 * 查什么、该装哪个包都由服务端判断（server/src/update.ts）：令牌在那一边，
 * 页面只管显示和触发。桌面端还要多一步安装，那件事归 Electron 外壳。
 */

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
  enabled: boolean;
  current: string;
  latest: UpdateRelease | null;
  self: { version: string; notes: string } | null;
  error?: string;
}

export interface UpdateProgress {
  phase: 'download' | 'verify' | 'install';
  received: number;
  total: number;
}

interface DesktopUpdateBridge {
  start(payload: { version: string; name: string; size: number; digest: string }): Promise<{ ok: boolean; error?: string }>;
  onProgress(callback: (progress: UpdateProgress) => void): () => void;
}

interface DesktopBridge {
  version: string;
  platform: string;
  update: DesktopUpdateBridge;
}

declare global {
  interface Window {
    /** 桌面端外壳通过 preload 注入。浏览器和安卓上没有这一项 */
    xfDesktop?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.xfDesktop;
}

/** 是不是装在桌面端外壳里。浏览器里打开页面不算 */
export function isDesktopClient(): boolean {
  return Boolean(desktopBridge()?.version);
}

export type UpdatePlatform = 'win' | 'android';

export function updatePlatform(): UpdatePlatform {
  return isDesktopClient() ? 'win' : 'android';
}

/** 版本号只比数字：1.2.10 要大于 1.2.9，按字符串比会反过来 */
function parseVersion(raw: string): number[] {
  const core = String(raw ?? '').trim().replace(/^v/i, '').split(/[-+]/)[0] ?? '';
  const parts = core.split('.').map((piece) => {
    const n = Number.parseInt(piece, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return parts.length ? parts : [0];
}

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

const SEEN_KEY = 'xf-rine:seen-version';
const PENDING_KEY = 'xf-rine:pending-update';

/**
 * 开始安装之前，把这一版的说明先存在本地。
 *
 * 装完第一次启动时 GitHub 可能连不上（代理、断网），那一版的说明就取不到了。
 * 存一份在本机，离线也能把「这次更新了什么」摆出来。
 */
export function savePendingUpdate(version: string, notes: string): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ version, notes }));
  } catch { /* 存不了就靠联网查那一路 */ }
}

export function readPendingUpdate(): { version: string; notes: string } | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: unknown; notes?: unknown };
    const version = String(parsed.version ?? '').trim();
    if (!version) return null;
    return { version, notes: String(parsed.notes ?? '') };
  } catch {
    return null;
  }
}

export function clearPendingUpdate(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch { /* 同上 */ }
}

/** 上次启动时是什么版本。用来判断「刚升级完」 */
export function seenVersion(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function markVersion(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch { /* 隐私模式存不了就算了 */ }
}

/**
 * 问一下有没有新版。
 *
 * 浏览器里不查：更新的是装好的程序，浏览器没有安装包可装。
 * 出错时返回 null —— 离线、限流、没配令牌都不该在页面上留一行红字。
 */
export async function checkForUpdate(): Promise<UpdateCheck | null> {
  if (!isDesktopClient() && !isNative()) return null;
  try {
    return await jget<UpdateCheck>('/api/update/check?platform=' + updatePlatform());
  } catch {
    return null;
  }
}

export interface UpdateDecision {
  mode: 'none' | 'available' | 'updated';
  info: UpdateCheck | null;
  /** 刚装完那一次看过之后，还有没有更新的版本要接着提示 */
  after: UpdateCheck | null;
  /** 该把「见过的版本」记成什么。空串表示不记 */
  remember: string;
}

/**
 * 这一启动该弹什么。
 *
 * 三种来源，优先级从高到低：
 *   1. 本地存着的说明 + 外壳给的当前版本相等 —— 刚装完，离线也认；
 *   2. 服务端说当前这版比上次启动的版本新 —— 刚升级完；
 *   3. 服务端说有更新版本 —— 提示更新。
 * 纯函数，不读也不写存储，方便单测（web/scripts/check-update-flow.ts）。
 */
export function decideUpdate(input: {
  /** 桌面外壳给的版本，只有桌面端有 */
  installed?: string;
  /** 开始安装前存下的说明 */
  pending?: { version: string; notes: string } | null;
  /** 上次启动时记下的版本 */
  seen?: string;
  /** 服务端返回的检查结果 */
  result?: UpdateCheck | null;
}): UpdateDecision {
  const installed = (input.installed ?? '').trim();
  const pending = input.pending ?? null;
  if (installed && pending && compareVersions(pending.version, installed) === 0) {
    return {
      mode: 'updated',
      info: {
        enabled: true,
        current: installed,
        latest: null,
        self: { version: pending.version, notes: pending.notes },
      },
      after: null,
      remember: installed,
    };
  }

  const result = input.result ?? null;
  if (!result || !result.enabled) return { mode: 'none', info: null, after: null, remember: installed };

  const current = (result.self?.version || result.current || '').trim();
  const seen = (input.seen ?? '').trim();
  if (current && seen && compareVersions(seen, current) < 0) {
    return {
      mode: 'updated',
      info: result,
      after: result.latest ? result : null,
      remember: current,
    };
  }
  return {
    mode: result.latest ? 'available' : 'none',
    info: result.latest ? result : null,
    after: null,
    remember: current,
  };
}

/**
 * 安卓的安装包地址。
 *
 * 点击后交给系统浏览器下载：APK 只能由系统安装器装，页面没那个权限。
 * 手机端的服务端要求带口令，浏览器发不了自定义头，所以口令走查询参数。
 */
export function apkDownloadUrl(version: string): string {
  const token = remoteToken();
  return apiUrl('/api/update/download')
    + '?platform=android&version=' + encodeURIComponent(version)
    + (token ? '&token=' + encodeURIComponent(token) : '');
}
