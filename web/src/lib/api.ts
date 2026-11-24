/**
 * 接口调用与错误映射。
 *
 * 形状（请求/响应类型）已经搬到 @xfrine/contract —— 那是 web 与 server 共用的一份，
 * 这里只保留发请求、解响应、把错误翻成人话这三件事的全部运行时逻辑。
 */

import { apiUrl, authHeaders } from './endpoint.ts';

/**
 * 解锁令牌失效的通知。
 *
 * 令牌在服务端内存里，服务重启或者在别处锁定过之后就没了 ——
 * 页面自己看不出来，仍写着「交易已解锁」。任何一个需要解锁的请求被 NOT_ARMED
 * 拒掉时，这里立刻通知界面落锁，别让人对着一个假的已解锁状态反复点。
 */
let notArmedHandler: (() => void) | null = null;

export function setNotArmedHandler(fn: (() => void) | null): void {
  notArmedHandler = fn;
}

export class ApiError extends Error {
  label: string;
  status: number;
  constructor(label: string, detail: string, status: number) {
    super(detail || label);
    this.label = label;
    this.status = status;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const b = body as { error?: string; detail?: string } | null;
    if (res.status === 403 && b?.error === 'NOT_ARMED') notArmedHandler?.();
    throw new ApiError(b?.error ?? `HTTP_${res.status}`, b?.detail ?? text.slice(0, 300), res.status);
  }
  return body as T;
}

export function jget<T>(url: string, init?: RequestInit): Promise<T> {
  // 口令和地址都在这里补：调用方写的一律是 /api/xxx，手机端才会拼到电脑上
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() };
  // 兜一个超时：没有它，一个卡住的请求会让面板一直停在上一帧，看着像「数据不动了」
  const signal = init?.signal ?? AbortSignal.timeout(20_000);
  return fetch(apiUrl(url), {
    ...init,
    cache: 'no-store',
    signal,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
    .then(parse<T>);
}

export function jsend<T>(
  method: 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  token?: string,
  /** 用来中途取消（AI 分析点「停止」时用） */
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-arm-token'] = token;
  // 写接口的超时给得宽：服务端自己可能已经超时重试过两轮。这里只是别让按钮永远转下去；
  // 真超时的时候服务端那边会给一句「不确定有没有受理」，页面照它说的去核对
  const ctl = signal ?? AbortSignal.timeout(45_000);
  return fetch(apiUrl(url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl }).then(parse<T>);
}


// ---------- 类型 ----------

/**
 * 形状全部来自 @xfrine/contract。用 `export type *` 而不是 `export *`：
 * 这个包只有类型，写成值导出会让构建工具试图去解析一个不存在的运行时入口。
 */
export type * from '@xfrine/contract';
