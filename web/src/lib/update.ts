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

/**
 * 这份程序的版本号。
 *
 * 桌面端由外壳通过 preload 递进来；手机端是安装包里的那个 versionName，
 * 由本地的 AppUpdate 插件报上来 —— 页面自己拿不到，Capacitor 也不代劳。
 * 浏览器里两边都是空串。
 */
export function installedVersion(): string {
  return (desktopBridge()?.version ?? phoneUpdate()?.version ?? '').trim();
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
  mode: 'none' | 'available' | 'updated' | 'install';
  info: UpdateCheck | null;
  /** 刚装完那一次看过之后，还有没有更新的版本要接着提示 */
  after: UpdateCheck | null;
  /** 该把「见过的版本」记成什么。空串表示不记 */
  remember: string;
  /**
   * 这一版「有新版本」时，安装包是不是已经落在手机上了。
   *
   * 手机上下了不装的情况很常见：系统安装器弹出来，人按了返回；或者权限没开就先跳走了。
   * 下一次进来再显示「发现新版本 / 下载安装包」是错的 —— 包已经在本地，
   * 该给的是「立即安装」。桌面端和浏览器里恒为 null。
   */
  downloaded: InstallPackage | null;
}

/**
 * 这一启动该弹什么。
 *
 * 四种来源，优先级从高到低：
 *   1. 本地存着的说明 + 当前版本相等 —— 刚装完，离线也认；
 *   2. 手机上已经下好了比当前更新的包 —— 提示的是「装」，不是「再下一遍」；
 *   3. 服务端说当前这版比上次启动的版本新 —— 刚升级完；
 *   4. 服务端说有更新版本 —— 提示更新。
 * 纯函数，不读也不写存储，方便单测（web/scripts/check-update-flow.ts）。
 */
export function decideUpdate(input: {
  /** 装着的这一份的版本号：桌面外壳给的，或手机插件报的 */
  installed?: string;
  /** 开始安装前存下的说明 */
  pending?: { version: string; notes: string } | null;
  /** 上次启动时记下的版本 */
  seen?: string;
  /** 服务端返回的检查结果 */
  result?: UpdateCheck | null;
  /** 手机上已经下载好的那个包（桌面端和浏览器没有这一项） */
  downloaded?: InstallPackage | null;
}): UpdateDecision {
  const installed = (input.installed ?? '').trim();
  const result = input.result ?? null;
  const current = (result?.self?.version || result?.current || installed || '').trim();

  /**
   * 本地那个包还算不算「有待安装的更新」。
   *
   * 三件事同时成立才算：比装着的这版新、文件名是 apk、大小对得上。
   * 最后一条挡的是「下到一半就被清掉、元数据还在」那种包 —— 让用户点「安装」
   * 然后系统安装器说解析失败，比一开始就说「要重新下载」难受得多。
   */
  const downloaded = input.downloaded ?? null;
  /**
   * 比的基准是「装着的这一版」，不是服务端自报的版本。
   *
   * 后者在手机上一般和当前 APK 同版本（服务端就是装进来的那一份），
   * 但它终究是「哪份服务端在回答」，不是「哪份程序在手机上」——
   * 判断一个包能不能覆盖安装，后者才是准的。拿不到就退回服务端那个。
   */
  const baseline = installed || current;
  const ready = downloaded
    && /\.apk$/i.test(downloaded.name ?? '')
    && downloaded.size > 0
    && compareVersions(downloaded.version, baseline) > 0
    ? downloaded
    : null;

  const pending = input.pending ?? null;
  if (installed && pending && compareVersions(pending.version, installed) === 0 && !ready) {
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
      downloaded: null,
    };
  }

  if (!result || !result.enabled) {
    // 查更新失败（离线、限流）但包里就躺着一个待装的：这件事不该被网络状态吃掉
    if (ready) {
      return {
        mode: 'install',
        info: {
          enabled: true,
          current: current || installed,
          latest: {
            version: ready.version,
            notes: ready.notes,
            publishedAt: '',
            asset: { name: ready.name, size: ready.size, digest: ready.digest },
          },
          self: null,
        },
        after: null,
        remember: current || installed,
        downloaded: ready,
      };
    }
    return { mode: 'none', info: null, after: null, remember: installed, downloaded: null };
  }

  const seen = (input.seen ?? '').trim();
  if (current && seen && compareVersions(seen, current) < 0 && !ready) {
    return {
      mode: 'updated',
      info: result,
      after: result.latest ? result : null,
      remember: current,
      downloaded: null,
    };
  }

  /**
   * 已经有下好的包：这一弹要说的就是「装」，不是「再下一遍」。
   *
   * 标题、副标题、按钮三处都不一样，所以单独给一个 mode，
   * 而不是让 available 带着一个 pending 硬它自己判断。
   * 更新说明仍然用服务端查询给出的那份（Release 里的原文）；离线时退回包里带着的那份。
   */
  if (ready) {
    const notes = result.latest?.notes ?? ready.notes;
    return {
      mode: 'install',
      info: {
        enabled: true,
        current: current || installed,
        latest: result.latest
          ? { ...result.latest, notes }
          : {
              version: ready.version,
              notes,
              publishedAt: '',
              asset: { name: ready.name, size: ready.size, digest: ready.digest },
            },
        self: null,
      },
      after: null,
      remember: current,
      downloaded: ready,
    };
  }

  return {
    mode: result.latest ? 'available' : 'none',
    info: result.latest ? result : null,
    after: null,
    remember: current,
    downloaded: null,
  };
}

/**
 * 安卓安装包的下载地址。
 *
 * 和电脑端是同一条：都打本机服务端的 /api/update/download，由服务端去 GitHub 取
 * 对应的那份资产再转发回来。电脑端由外壳拿这个地址下载，手机端由 AppUpdate 插件下载 ——
 * 一行服务端代码都不必改，选哪个包、算不算合法都是同一套。
 *
 * 口令走查询参数而不是请求头：浏览器里打开这个地址时发不了自定义头。
 * 插件那条路另外还会带 x-remote-token。
 */
export function apkDownloadUrl(version: string): string {
  const token = remoteToken();
  return apiUrl('/api/update/download')
    + '?platform=android&version=' + encodeURIComponent(version)
    + (token ? '&token=' + encodeURIComponent(token) : '');
}

/**
 * 手机上已经下载好的那个安装包。
 *
 * 页面拿不到文件系统，这份信息由 AppUpdate 插件读本地元数据后报上来。
 * 它存在的意义是「下了没装」这种情况：下次进来该给的是「立即安装」。
 */
export interface InstallPackage {
  version: string;
  name: string;
  size: number;
  digest: string;
  /** 落盘位置，弹窗里给用户看的 */
  path: string;
  /** 已下载这个包时那一版的更新说明，离线也摆得出来 */
  notes: string;
  /** 下载完成的时间，ms */
  at: number;
}

export interface AppUpdateBridge {
  /** 装着的这一份的版本号（APK 的 versionName） */
  version: string;
  pending(): Promise<InstallPackage | null>;
  download(payload: { url: string; version: string; name: string; size: number; digest: string; notes: string }): Promise<InstallPackage>;
  install(): Promise<{ started: boolean; reason?: string }>;
  onProgress(callback: (progress: UpdateProgress) => void): () => void;
}

declare global {
  interface Window {
    /**
     * 手机壳通过 Capacitor 的 registerPlugin 挂上来。
     *
     * 单测和浏览器里没有这一项；同步读是为了能在渲染时就知道「这儿是不是手机」。
     */
    xfAppUpdate?: AppUpdateBridge;
  }
}

/** 手机上更新用的本地插件。浏览器和桌面端返回 undefined */
export function phoneUpdate(): AppUpdateBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.xfAppUpdate;
}

/** 手机上已经下好、还没装的包。没有插件（桌面端、浏览器）返回 null */
export async function pendingInstall(): Promise<InstallPackage | null> {
  try {
    return (await phoneUpdate()?.pending()) ?? null;
  } catch {
    return null;
  }
}
