import crypto from 'node:crypto';
import { config } from '../config.js';
import { GateError } from '../exchange/errors.js';
// 出网统一走 netFetch：配了系统代理时它会自动跟着走
import { netFetch } from '../net.js';

/**
 * Bitget v2（U 本位合约）。
 *
 * 有几处和 Gate 完全不一样，写在这里省得后面每次调用都重新踩一遍：
 *
 *   · 签名串是 timestamp + METHOD + path + query/body，**GET 的 query 要按原文
 *     （没被百分号编码的）参与签名**，而且顺序要排好 —— 签名和 URL 用的必须是同一个顺序。
 *   · 私有接口还要 ACCESS-PASSPHRASE（创建密钥时自己设的口令），这是第三把钥匙。
 *   · 业务错误一律回 HTTP 200，真正的结果在 body.code 里：'00000' 才是成功。
 *   · 模拟盘不换域名，靠在请求头里加 PAPTRADING: 1。
 *   · 订单号是 19 位整数，超过 JS 安全整数范围，直接 JSON.parse 会被截断 —— 拿去撤单就是
 *     「找不到这张单」。这里和 gate/rest.ts 一样，先把超长整数字面量包成字符串。
 */

export const BASE = 'https://api.bitget.com';
const TIMEOUT_MS = 15_000;
/** 合约表的 productType，全项目只用 U 本位 */
export const PRODUCT = 'USDT-FUTURES';

/** 币本位 / 交割合约不在支持范围内：合约名里带下划线日期的是交割合约 */
export function isDatedSymbol(symbol: string): boolean {
  return symbol.includes('_');
}

function encodeQuery(params: Record<string, string | number | boolean | undefined>): {
  url: string;
  raw: string;
} {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    entries.push([k, String(v)]);
  }
  // 顺序必须固定：签名和 URL 各拼一次，两次顺序不一样交易所就算不出同一个签名
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    url: entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
    raw: entries.map(([k, v]) => `${k}=${v}`).join('&'),
  };
}

/** Make Bitget's permission error actionable without hiding its original message. */
function bitgetErrorDetail(code: unknown, message: unknown, path: string): string {
  const detail = String(message ?? '交易所没有说明原因');
  if (String(code) !== '40014') return detail;
  const envHint = config.env === 'testnet'
    ? '模拟盘请使用在 Bitget 模拟交易环境创建的 Demo API Key，并填入本程序设置页的「模拟盘」密钥栏；'
    : '请确认使用的是本程序设置页「实盘」对应的 API Key；';
  return `${detail}（请求接口：${path}）。${envHint}同时确认 API Key 已开启合约仓位读取权限（需要交易时再开启写入权限）。`;
}

interface Options {
  /** 私有接口要签名、走「下单环境」那个地址 */
  isPrivate?: boolean;
  /** 这次调用的截止时间 */
  timeoutMs?: number;
  /** 单条出网路径的等待上限，不能小于截止时间，否则 8 秒那条先到 */
  attemptMs?: number;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  body?: Record<string, unknown>,
  opts: Options = {},
): Promise<T> {
  const { isPrivate = false, timeoutMs = TIMEOUT_MS } = opts;
  const q = encodeQuery(params);
  const query = method === 'GET' ? q.url : '';
  const rawForSign = method === 'GET' ? q.raw : '';
  const url = BASE + path + (query ? `?${query}` : '');
  const bodyStr = method === 'POST' && body ? JSON.stringify(body) : '';

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (bodyStr) headers['Content-Type'] = 'application/json';
  // 模拟盘用的是同一个域名，靠这个头把请求切到模拟账户
  if (config.env === 'testnet') headers.PAPTRADING = '1';

  if (isPrivate) {
    if (!config.key || !config.secret || !config.passphrase) {
      throw new GateError(
        401, 'NO_KEYS',
        '服务端未配置 Bitget 的 KEY / SECRET / PASSPHRASE，请到设置页填写（三样都要）',
        'Bitget',
      );
    }
    const ts = Date.now().toString();
    const payload =
      ts + method + path + (method === 'GET' ? (rawForSign ? `?${rawForSign}` : '') : bodyStr);
    headers['ACCESS-KEY'] = config.key;
    headers['ACCESS-SIGN'] = crypto.createHmac('sha256', config.secret).update(payload).digest('base64');
    headers['ACCESS-TIMESTAMP'] = ts;
    headers['ACCESS-PASSPHRASE'] = config.passphrase;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const perTry = opts.attemptMs && opts.attemptMs > 0 ? opts.attemptMs : timeoutMs;
  const failed = (e: unknown): unknown => {
    const name = e instanceof Error ? e.name : '';
    if (name !== 'TimeoutError' && name !== 'AbortError') return e;
    const secs = Math.round(timeoutMs / 1000);
    if (method === 'GET') return new GateError(504, 'UPSTREAM_TIMEOUT', `${path} 在 ${secs} 秒内没有答复，过一会儿再试`, 'Bitget');
    return new GateError(
      504,
      'UNKNOWN_RESULT',
      `${path} 超时（${secs} 秒）：不确定交易所是否已经受理这一单。`
      + '先到「委托 / 持仓」里核对，别直接重点 —— 重复下单会变成两单。',
      'Bitget',
    );
  };

  try {
    let res: Awaited<ReturnType<typeof netFetch>>;
    let text: string;
    try {
      res = await netFetch(url, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: ac.signal,
      }, { preferDirect: true, private: isPrivate, attemptMs: perTry });
      text = await res.text();
    } catch (e) {
      throw failed(e);
    }

    // 订单号和 clientOid 都是 19 位整数，超过 Number.MAX_SAFE_INTEGER
    const safeText = text.replace(/:\s*(-?\d{16,})(?=\s*[,}\]]\s*(?:"|}|]))/g, ':"$1"');
    let json: any = null;
    try { json = JSON.parse(safeText); } catch { /* 不是 JSON，下面按原文报错 */ }

    if (!res.ok) {
      const label = json?.code ? String(json.code) : `HTTP_${res.status}`;
      const detail = bitgetErrorDetail(json?.code ?? label, json?.msg ?? json?.message ?? text.slice(0, 300), path);
      throw new GateError(res.status, label, detail, 'Bitget');
    }
    if (!json || typeof json !== 'object') {
      throw new GateError(502, 'BAD_RESPONSE', `${path} 回的不是 JSON：${text.slice(0, 200)}`, 'Bitget');
    }
    // 业务错误也是 200，只能看 code
    if (json.code !== '00000') {
      throw new GateError(400, String(json.code ?? 'UNKNOWN'), bitgetErrorDetail(json.code, json.msg, path), 'Bitget');
    }
    return json.data as T;
  } finally {
    clearTimeout(timer);
  }
}

export const bgPublic = <T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  timeoutMs?: number,
  attemptMs?: number,
): Promise<T> => request<T>('GET', path, params, undefined, { timeoutMs, attemptMs });

export const bgPrivate = <T>(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  body?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<T> => request<T>(method, path, params, body, { isPrivate: true, timeoutMs });
