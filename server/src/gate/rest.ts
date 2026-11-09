import crypto from 'node:crypto';
import { config, restBaseUrl, publicBaseUrl } from '../config.js';

const PREFIX = '/api/v4';
const TIMEOUT_MS = 15_000;

export class GateError extends Error {
  status: number;
  label: string;
  detail: string;
  constructor(status: number, label: string, detail: string) {
    super(`Gate ${status} ${label}: ${detail}`);
    this.status = status;
    this.label = label;
    this.detail = detail;
  }
}

function sign(method: string, path: string, query: string, body: string, ts: string): string {
  const bodyHash = crypto.createHash('sha512').update(body).digest('hex');
  const payload = `${method}\n${path}\n${query}\n${bodyHash}\n${ts}`;
  return crypto.createHmac('sha512', config.secret).update(payload).digest('hex');
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  body?: unknown,
  isPrivate = false,
): Promise<T> {
  // 不能只给 GET/DELETE 拼 query：Gate 的「改杠杆」是 POST 但参数放在 query 上。
  const query = buildQuery(params);
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const fullPath = PREFIX + path;
  const url = (isPrivate ? restBaseUrl() : publicBaseUrl()) + fullPath + (query ? `?${query}` : '');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (bodyStr) headers['Content-Type'] = 'application/json';
  if (config.key && config.secret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    headers.KEY = config.key;
    headers.Timestamp = ts;
    headers.SIGN = sign(method, fullPath, query, bodyStr, ts);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr || undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    // Gate 的订单号和触发单号是 17 位整数，超过 JS 安全整数范围。
    // 直接 JSON.parse 会被 double 截断，拿去撤单就会 ORDER_NOT_FOUND。
    // 先把超长整数字面量包成字符串，再解析。
    const safeText = text.replace(/:\s*(-?\d{16,})(?=\s*[,}\]])/g, ':"$1"');
    if (!res.ok) {
      let label = `HTTP_${res.status}`;
      let detail = text.slice(0, 500);
      try {
        const j = JSON.parse(text);
        label = j.label ?? j.message ?? label;
        detail = j.detail ?? j.message ?? j.error ?? detail;
      } catch { /* keep raw */ }
      throw new GateError(res.status, label, typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return (safeText ? JSON.parse(safeText) : null) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const gatePublic = <T>(path: string, params: Record<string, string | number | boolean | undefined> = {}) =>
  request<T>('GET', path, params);

export function requireKeys(): void {
  if (!config.key || !config.secret) {
    throw new GateError(401, 'NO_KEYS', '服务端未配置 GATE_KEY / GATE_SECRET，请到设置页填写密钥');
  }
}

export const gatePrivate = <T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  body?: unknown,
): Promise<T> => {
  requireKeys();
  return request<T>(method, path, params, body, true);
};
