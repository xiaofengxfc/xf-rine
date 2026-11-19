import { ApiError } from './errors';

export interface Reply {
  ok: boolean;
  status: number;
  body: any;
  text: string;
}

/**
 * 出网请求。
 *
 * Workers 里没有 undici，也没有系统代理这回事 —— Cloudflare 自己就是出口，
 * 所以这里只要 fetch + 超时。超时必须给：没有它，一个卡住的请求会让页面上
 * 那块面板一直停在上一帧，看着像「数据不动了」。
 */
export async function request(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Reply> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* 不是 JSON，交给调用方看 text */ }
    return { ok: res.ok, status: res.status, body, text };
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'AbortError') {
      throw new ApiError(504, 'UPSTREAM_TIMEOUT', '上游 ' + Math.round(timeoutMs / 1000) + ' 秒没有答复，过一会儿再试');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gate 的订单号、触发单号是 17 位整数，超过 JS 安全整数范围。
 * 直接 JSON.parse 会被截成 double，拿去撤单只会得到 ORDER_NOT_FOUND。
 * 先把超长整数字面量包成字符串再解析。
 */
export function parseBigInts(text: string): any {
  if (!text) return null;
  const masked = text.replace(/([:[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
  return JSON.parse(masked);
}

/** hex 输出，签名用 */
export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** base64 输出，Bitget 要这个 */
export function toB64(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}
