/**
 * Worker 版的错误。形状和服务端的 GateError 对齐：{ error, detail, status }。
 * 页面只认这三个字段，所以不管底下哪一家、哪一层出的错，最后都落到这里。
 */
export class ApiError extends Error {
  status: number;
  label: string;
  detail: string;

  constructor(status: number, label: string, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.label = label;
    this.detail = detail;
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function toResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return json({ error: e.label, detail: e.detail, status: e.status }, e.status);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return json({ error: 'INTERNAL', detail: msg, status: 500 }, 500);
}
