import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { AppUpdateBridge, InstallPackage, UpdateProgress } from './update.ts';
import { isNative } from './endpoint.ts';

/**
 * 手机上的安装更新。
 *
 * 电脑端这件事归 Electron 外壳：主进程下载、校验、起安装器。手机上没有主进程那层，
 * 但有一套同样的东西 —— 本地 Node 服务端在 127.0.0.1:8787 上跑着 /api/update/download，
 * 所以下载走的是和电脑端一模一样的地址、同一份资产、同一个 sha256。
 *
 * 原生那一侧（AppUpdatePlugin.java）负责三件页面做不到的事：
 *   - 往 App 私有目录写一百多兆的安装包，边写边算 sha256；
 *   - 查「安装未知应用」这个开关，没开就把人送到系统那个页面去；
 *   - 把落盘的 APK 交给系统安装器（ACTION_VIEW + FileProvider）。
 *
 * 这一层只负责把这些能力挂到页面上。浏览器和桌面端没有这个插件，
 * 调用方要按 isPhoneUpdate() 分叉。
 */

/** 「安装未知应用」这个开关的状态 */
export interface AppUpdatePermission {
  /** 能不能装：API 26+ 是「安装未知应用」这个按 App 记的开关，更早是「非市场来源」总开关 */
  granted: boolean;
  /** 系统的 API 级别，弹窗里按它换措辞（有的 ROM 叫「未知来源」，有的叫「安装外部应用」） */
  sdk: number;
}

interface NativeAppUpdatePlugin {
  version(): Promise<{ version: string }>;
  pending(): Promise<{ pending: InstallPackage | null }>;
  download(options: {
    url: string;
    version: string;
    name: string;
    size: number;
    digest: string;
    notes: string;
  }): Promise<{ pending: InstallPackage }>;
  install(): Promise<{ started: boolean; reason?: string }>;
  discard(): Promise<void>;
  permission(): Promise<AppUpdatePermission>;
  openPermissionSettings(): Promise<{ opened: boolean }>;
  /**
   * 原生主动推的事件。
   *
   * registerPlugin 的代理不认「插件自己 notifyListeners」的那些方法名，
   * 监听得走 addListener，返回的句柄用来关掉 —— 所以这里声明的是 Capacitor 的监听协议，
   * 不是插件里的某个 @PluginMethod。
   */
  addListener(
    eventName: 'progress',
    listener: (event: { phase?: string; received?: number; total?: number }) => void,
  ): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<NativeAppUpdatePlugin>('AppUpdate');

/** 这个壳里有没有安装更新这条路。浏览器、桌面窗口都是 false */
export function isPhoneUpdate(): boolean {
  return isNative();
}

/**
 * 把插件挂到 window 上，让「当前装的是哪一版」同步可读。
 *
 * 为什么不每次调用都问插件：启动判定、弹窗、页头都要版本号，
 * 每处 await 一次就把渲染变成异步瀑布；而版本号在一次启动里不会变，问一次记住就够。
 * registerPlugin 本身不握手，真正的调用才过桥。
 *
 * 插件没编进来（旧包、浏览器）返回空串，调用方退回老做法。
 */
export async function attachPhoneUpdate(): Promise<string> {
  if (!isPhoneUpdate()) return '';
  let version = '';
  try {
    version = String((await Native.version())?.version ?? '').trim();
  } catch {
    return '';
  }
  if (!version) return '';
  const bridge: AppUpdateBridge = {
    version,
    pending: async () => (await Native.pending())?.pending ?? null,
    download: async (payload) => (await Native.download(payload))?.pending ?? null,
    install: () => Native.install(),
    onProgress: subscribeProgress,
  };
  window.xfAppUpdate = bridge;
  return version;
}

/**
 * 订阅下载进度。
 *
 * 不能写成 Native.onProgress —— registerPlugin 的代理只认原生真有那个方法，
 * 监听事件得走 Capacitor 自己的 addListener，否则调用会直接失败。
 */
function subscribeProgress(callback: (progress: UpdateProgress) => void): () => void {
  let closed = false;
  let handle: PluginListenerHandle | null = null;
  void Native.addListener('progress', (event) => {
    if (closed) return;
    const row = event as Partial<UpdateProgress> & { phase?: string };
    callback({
      phase: row.phase === 'verify' || row.phase === 'install' ? row.phase : 'download',
      received: Number(row.received) || 0,
      total: Number(row.total) || 0,
    });
  }).then((created) => {
    if (closed) void created.remove();
    else handle = created;
  }).catch(() => { /* 事件通道没了就只是没有进度条，下载照走 */ });
  return () => {
    closed = true;
    void handle?.remove();
  };
}

/** 现在能不能装。查不到就当能装 —— 真装的时候系统还会再拦一次 */
export async function installPermission(): Promise<AppUpdatePermission> {
  try {
    return await Native.permission();
  } catch {
    return { granted: true, sdk: 26 };
  }
}

/** 跳到系统那个「安装未知应用」的开关页。返回 false 表示没跳成，得给文字指引 */
export async function openInstallPermission(): Promise<boolean> {
  try {
    return Boolean((await Native.openPermissionSettings())?.opened);
  } catch {
    return false;
  }
}

/**
 * 让系统安装器弹出来。
 *
 * 原生那边先自己再查一次权限、再验一遍包名/版本号/签名，所以这里返回的
 * started=false 是要照着给的：permission / missing / older / signature / bad。
 */
export async function installPendingPackage(): Promise<{ started: boolean; reason?: string }> {
  try {
    return await Native.install();
  } catch (e) {
    return { started: false, reason: (e as Error)?.message || 'unknown' };
  }
}

/** 丢掉下好的包（用户明确不想要这一版时） */
export async function discardPendingPackage(): Promise<void> {
  try {
    await Native.discard();
  } catch { /* 删不掉下次还会冒出来，不至于因此报错 */ }
}

export { Native as AppUpdate };
