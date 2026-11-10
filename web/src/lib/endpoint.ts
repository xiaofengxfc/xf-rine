/**
 * 服务端在哪。
 *
 * 浏览器和桌面端：页面和接口同源，路径直接用 /api —— 不用配，也不怕换端口。
 * 手机 App：页面是 WebView 从 http://localhost 读出来的，后端在同一个 App 里的
 * 127.0.0.1:8787 上（内置 Node 运行时），不同源，所以地址要在启动时定下来，
 * 之后每个请求都拼到它前面。口令只有「连电脑」那条后路才用得上。
 */
const BASE_KEY = 'xf-rine:server';
const TOKEN_KEY = 'xf-rine:server-token';

/** 是不是装成了 App（Capacitor）。浏览器和桌面端都返回 false */
export function isNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  try {
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    return false;
  }
}

/** 把用户随手填的东西补成完整地址：192.168.1.5:8787 / http://x / http://x/ 都认 */
export function normalizeBase(raw: string): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    // 隐私模式下 localStorage 会直接抛异常，当成没存过
    return '';
  }
}

let cachedBase: string | null = null;

/** 服务端地址。空字符串表示「和页面同源」 */
export function apiBase(): string {
  if (cachedBase === null) cachedBase = normalizeBase(read(BASE_KEY));
  return cachedBase;
}

export function remoteToken(): string {
  return read(TOKEN_KEY).trim();
}

export function saveTarget(base: string, token: string): void {
  const b = normalizeBase(base);
  try {
    localStorage.setItem(BASE_KEY, b);
    localStorage.setItem(TOKEN_KEY, token.trim());
  } catch { /* 存不了就这一次先用着 */ }
  cachedBase = b;
}

export function clearTarget(): void {
  try {
    localStorage.removeItem(BASE_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* 同上 */ }
  cachedBase = null;
}

/** 相对路径 → 真正要请求的地址。同源时原样返回 */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return apiBase() + path;
}

/** 握手用的请求头：口令只在设过的时候带上 */
export function authHeaders(): Record<string, string> {
  const t = remoteToken();
  return t ? { 'x-remote-token': t } : {};
}

/**
 * 行情 WebSocket 的地址。
 * 浏览器升级请求带不了自定义头，口令只能挂在查询参数上。
 */
export function wsUrl(path = '/ws'): string {
  const base = apiBase();
  const token = remoteToken();
  if (!base) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    if (!token) return proto + '://' + location.host + path;
    return proto + '://' + location.host + path + '?token=' + encodeURIComponent(token);
  }
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = path;
  u.search = token ? '?token=' + encodeURIComponent(token) : '';
  return u.toString();
}

/**
 * 探一次服务端。
 * 手机端每次启动都先问一句 —— 连不上就直接停在填地址那一屏，
 * 而不是进到主界面看一屏空图表、再去猜是哪里出了问题。
 */
export async function probeServer(base: string, token: string, timeoutMs = 6000): Promise<{ ok: boolean; error?: string }> {
  const url = normalizeBase(base) + '/api/health';
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: token.trim() ? { 'x-remote-token': token.trim() } : {},
    });
    if (res.status === 401) return { ok: false, error: '口令不对，抄一遍电脑设置页里的那串' };
    if (!res.ok) return { ok: false, error: '服务端回了 HTTP ' + res.status };
    const body = (await res.json()) as { ok?: boolean };
    return body?.ok ? { ok: true } : { ok: false, error: '这个地址上跑的不是巡风服务端' };
  } catch (e) {
    const msg = (e as Error)?.name === 'TimeoutError' ? '连接超时' : '连不上';
    return { ok: false, error: msg + '，确认电脑和手机在同一个 Wi-Fi，电脑上的程序开着' };
  }
}
