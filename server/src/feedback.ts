import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { hostname, platform, release, type } from 'node:os';
import { restBaseUrl, envLabel } from './config.js';

/**
 * 反馈邮件直发。
 *
 * 没装 nodemailer：这个服务端只发一种信（一小段纯文本反馈），
 * 为一个功能多背一个依赖、一份上游维护成本不划算 —— 对着 SMTP 说那几句必要的话就够了。
 *
 * 163 的几条硬要求，写在这里免得以后踩同样的坑：
 *   1. 走 465 端口 SSL 直连。25 端口在多数家宽和云主机上被封，587 的 STARTTLS 也不是每个环境都通；
 *   2. 认证用「客户端授权码」，不是登录密码 —— 填密码会一直 535；
 *   3. From 必须就是认证的那个账号。写别名或别的地址都会被当伪造，直接退信；
 *   4. 中文标题要走 RFC 2047 编码，正文按 base64 走，不然 163 会按 GBK 乱码收下。
 *
 * 这三项默认内嵌在下面，设置页里不出现 —— 用户不用配任何东西就能反馈。
 * 想换的话（比如换个发件账号）用环境变量覆盖，代码不用动。
 */
export const FEEDBACK_DEFAULT = {
  from: 'nieke95519@163.com',
  /** 163 邮箱「设置 → POP3/SMTP/IMAP」里生成的客户端授权码 */
  auth: 'NAXxW65d6qsdtyqr',
  to: 'yileina0511@163.com',
} as const;

const SMTP_HOST = 'smtp.163.com';
const SMTP_PORT = 465;
/** 一步等多久。整封信正常两秒内发完；卡住时宁可报错，也别让页面转圈转到天荒地老 */
const STEP_TIMEOUT = 20_000;

export interface FeedbackSettings {
  from: string;
  auth: string;
  to: string;
}

/** 内嵌值优先，环境变量可以整个换掉（三项各管各的） */
export function feedbackSettings(): FeedbackSettings {
  const pick = (name: string, fallback: string): string => {
    const v = (process.env[name] ?? '').trim();
    return v || fallback;
  };
  return {
    from: pick('FEEDBACK_SMTP_USER', FEEDBACK_DEFAULT.from),
    auth: pick('FEEDBACK_SMTP_PASS', FEEDBACK_DEFAULT.auth),
    to: pick('FEEDBACK_TO', FEEDBACK_DEFAULT.to),
  };
}

/** 给设置页看的：发到哪个信箱、能不能发（授权码在不在） */
export function feedbackTarget(): { to: string; from: string; ready: boolean } {
  const s = feedbackSettings();
  return { to: s.to, from: s.from, ready: Boolean(s.from && s.auth && s.to) };
}

/** 发信失败时抛这个，路由层原样回给页面 */
export class FeedbackError extends Error {
  readonly label: string;
  constructor(label: string, detail: string) {
    super(detail || label);
    this.label = label;
  }
}

// ---------- SMTP 会话 ----------

interface Reply {
  code: number;
  text: string;
}

/**
 * 一条连接上的最小 SMTP 客户端。
 *
 * 只支持「发一句、等一句」这种节奏（我们也不需要 pipelining）。
 * 回复可能是多行的：带连字符的 `250-xxx` 表示后面还有，最后一行是 `250 xxx`。
 */
class SmtpSession {
  private buf = '';
  private pendingLines: string[] = [];
  private queue: Reply[] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private dead: Error | null = null;

  constructor(private readonly sock: TLSSocket) {
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => this.feed(chunk));
    sock.on('error', (e: Error) => this.fail(new Error('连不上邮件服务器：' + e.message)));
    sock.on('timeout', () => this.fail(new Error('邮件服务器没有响应')));
    sock.on('close', () => this.fail(new Error('邮件服务器提前断开了连接')));
  }

  private fail(e: Error): void {
    if (this.dead) return;
    this.dead = e;
    const w = this.waiter;
    if (w) {
      clearTimeout(w.timer);
      this.waiter = null;
      w.reject(e);
    }
  }

  private feed(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const idx = this.buf.indexOf('\n');
      if (idx < 0) return;
      const raw = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (!raw) continue;
      const m = /^(\d{3})([ -])(.*)$/.exec(raw);
      if (!m) {
        // 少数服务器会在中间插一行不带状态码的字，丢掉不影响判定
        this.pendingLines.push(raw);
        continue;
      }
      this.pendingLines.push(m[3]!);
      if (m[2] === '-') continue;
      const reply: Reply = { code: Number(m[1]), text: this.pendingLines.join(' ') };
      this.pendingLines = [];
      const w = this.waiter;
      if (w) {
        clearTimeout(w.timer);
        this.waiter = null;
        w.resolve(reply);
      } else {
        this.queue.push(reply);
      }
    }
  }

  private read(): Promise<Reply> {
    if (this.dead) return Promise.reject(this.dead);
    const hit = this.queue.shift();
    if (hit) return Promise.resolve(hit);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new FeedbackError('SMTP_TIMEOUT', '邮件服务器 ' + STEP_TIMEOUT / 1000 + ' 秒没有回应'));
      }, STEP_TIMEOUT);
      this.waiter = { resolve, reject, timer };
    });
  }

  private write(line: string): void {
    if (this.dead) return;
    this.sock.write(line + '\r\n');
  }

  /** 发一句、等一句；状态码不在 codes 里就当失败，把服务器原话带上 */
  async step(line: string | null, codes: number[], what: string): Promise<Reply> {
    if (line !== null) this.write(line);
    const r = await this.read();
    if (!codes.includes(r.code)) {
      throw new FeedbackError('SMTP_REJECTED', what + '：' + r.code + ' ' + r.text.trim());
    }
    return r;
  }

  close(): void {
    try { this.sock.end(); } catch { /* 已经断了就算了 */ }
    try { this.sock.destroy(); } catch { /* 同上 */ }
  }
}

function openSocket(): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const sock = tlsConnect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST }, () => {
      sock.setTimeout(STEP_TIMEOUT);
      sock.removeListener('error', onError);
      sock.removeListener('timeout', onTimeout);
      resolve(sock);
    });
    const onError = (e: Error) => {
      sock.destroy();
      reject(new FeedbackError('SMTP_CONNECT', '连不上 ' + SMTP_HOST + '：' + e.message));
    };
    /**
     * 握手阶段也可能一声不响：465 被防火墙丢掉时连 FIN 都不回来，
     * 回调永远不触发，Node 自己的握手超时要两分钟 —— 页面就一直转。
     * 这里先压一个 20 秒的底。
     */
    const onTimeout = () => {
      sock.destroy();
      reject(new FeedbackError('SMTP_CONNECT', '连不上 ' + SMTP_HOST + '：' + Math.round(STEP_TIMEOUT / 1000) + ' 秒没回应'));
    };
    sock.setTimeout(STEP_TIMEOUT);
    sock.once('error', onError);
    sock.once('timeout', onTimeout);
  });
}

// ---------- 信的内容 ----------

const KINDS: Record<string, string> = {
  bug: '功能异常',
  idea: '功能建议',
  other: '其他',
};

export function kindLabel(kind: string): string {
  return KINDS[kind] ?? KINDS.other!;
}

/**
 * 塞进头部字段（Subject 之类）之前先掐掉换行。
 *
 * MIME 头部是按行分隔的：标题里带一个 \r\n，后面那段就成了另一个头 ——
 * 用户反馈是公开接口，等于让任何人往这封信里加 Bcc、加 Content-Type。
 * 纯 ASCII 标题走的是不编码那条路，换行会原样落进头部，所以必须在最前面拦掉。
 */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 2047：标题里有中文就得编码，否则 163 会按 GBK 收成乱码 */
function encodeHeader(v: string): string {
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return '=?UTF-8?B?' + Buffer.from(v, 'utf8').toString('base64') + '?=';
}

/**
 * 正文按 base64 走：不用操心折行和点转义，中文也不会被中间某个环节转码。
 * base64 的字母表里没有 '.'，所以正文里也不可能拼出 SMTP 的结束符 "\r\n.\r\n" ——
 * 这也是选 base64 而不是 8bit 的原因之一。
 */
function base64Body(text: string): string {
  const b = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64');
  const lines = b.match(/.{1,76}/g) ?? [''];
  return lines.join('\r\n');
}

/** 本地时区的 RFC 2822 时间。用 toLocaleString 拼会带中文，服务器不认 */
function rfc2822(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number): string => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    days[d.getDay()] + ', ' + p(d.getDate()) + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    ' ' + sign + p(Math.floor(abs / 60)) + p(abs % 60)
  );
}

/** 页面上报上来的环境信息只当参考，长度和内容都收一道，别把整封信念成日志 */
function clip(v: string, max: number): string {
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

export interface FeedbackInput {
  kind: string;
  title: string;
  body: string;
  contact?: string;
  /** 页面当时的上下文：币种、周期、窗口大小之类，排问题时很有用 */
  extra?: Record<string, string>;
}

function buildMessage(input: FeedbackInput, s: FeedbackSettings, id: string): string {
  const now = new Date();
  const stamp = now.toLocaleString('zh-CN', { hour12: false });
  const extra = Object.entries(input.extra ?? {})
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => k + '：' + clip(v, 200))
    .join('\n');

  const lines = [
    '【' + kindLabel(input.kind) + '】' + input.title,
    '',
    '类型：' + kindLabel(input.kind),
    '时间：' + stamp,
    '联系方式：' + (input.contact?.trim() || '（没填）'),
    '环境：' + envLabel() + ' · ' + restBaseUrl(),
    '程序：' + type() + ' ' + platform() + ' ' + release() + ' · node ' + process.version + ' · ' + hostname(),
    '',
    '—— 正文 ——',
    input.body,
  ];
  if (extra) {
    lines.push('', '—— 页面当时的状态 ——', extra);
  }
  const body = base64Body(lines.join('\n'));

  return [
    'From: "巡风反馈" <' + s.from + '>',
    'To: <' + s.to + '>',
    'Subject: ' + encodeHeader('【巡风】' + kindLabel(input.kind) + '：' + headerSafe(input.title)),
    'Date: ' + rfc2822(now),
    'Message-ID: <' + id + '@xf-rine>',
    'X-Mailer: xf-rine',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/**
 * 发一封反馈。
 *
 * 顺序按 RFC 5321 的最小集合走：EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA。
 * 任何一步被拒都把服务器原话带回去 —— 「发送失败」四个字对排查没有半点用，
 * `535 Authentication failed` 才有。
 */
export async function sendFeedback(input: FeedbackInput): Promise<{ ok: true; to: string; at: number }> {
  const s = feedbackSettings();
  if (!s.from || !s.auth || !s.to) {
    throw new FeedbackError('FEEDBACK_NOT_CONFIGURED', '反馈信箱还没配好');
  }

  const id = randomUUID();
  const message = buildMessage(input, s, id);
  const sock = await openSocket();
  const smtp = new SmtpSession(sock);
  try {
    await smtp.step(null, [220], '邮件服务器打招呼');
    await smtp.step('EHLO ' + (hostname() || 'xf-rine'), [250], '握手');
    await smtp.step('AUTH LOGIN', [334], '开始认证');
    await smtp.step(Buffer.from(s.from, 'utf8').toString('base64'), [334], '发送账号');
    await smtp.step(Buffer.from(s.auth, 'utf8').toString('base64'), [235], '授权码不对（163 要的是客户端授权码，不是登录密码）');
    await smtp.step('MAIL FROM:<' + s.from + '>', [250], '发件人被拒');
    await smtp.step('RCPT TO:<' + s.to + '>', [250, 251], '收件人被拒');
    await smtp.step('DATA', [354], '准备接收正文');
    // 正文后面单独补一个结束行：点号单独一行才算这封信完
    await smtp.step(message + '\r\n.', [250], '这封信被服务器判为拒收');
    try { await smtp.step('QUIT', [221], '退出'); } catch { /* 信已经收了，QUIT 报错不重要 */ }
    return { ok: true, to: s.to, at: Date.now() };
  } finally {
    smtp.close();
  }
}
