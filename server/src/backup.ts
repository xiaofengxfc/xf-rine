import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENV_PATH, HOME_DIR, reloadConfig } from './config.js';

/**
 * 备份与恢复。
 *
 * 一个文件里同时装着两边的状态：服务端那几份 JSON 和 .env，以及浏览器
 * localStorage 里那些（画线、视口、偏好、服务器地址）。少一半的话，
 * 「换个电脑接着用」就只能恢复一半。
 *
 * 加密放在服务端做，不放在页面里：手机通过局域网 IP 打开页面时不是安全上下文，
 * 浏览器根本不给 crypto.subtle —— 备份功能会在手机上直接不可用。
 * 密码走的是同一条局域网链路，和填 API 密钥时那条是同一条，不额外多一个暴露面。
 *
 * 用 PBKDF2-SHA256 + AES-256-GCM。GCM 自带认证，密码错和文件被改都会在解密时报出来，
 * 不会解出一堆乱码再写进配置里。
 */

const FORMAT = 'xf-rine-backup';
const VERSION = 1;
const KDF_ITERATIONS = 250_000;
const MIN_PASSWORD = 8;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** 服务端这一侧要备份的文件，一律按原文存：格式由各自的模块负责，这里不解析 */
export interface BackupFiles {
  /** .env 全文（含两家的密钥） */
  env: string;
  /** 策略库 */
  strategies: string;
  /** AI 交易的策略与开关 */
  aiStrategy: string;
  /** 记住的本地数据目录 */
  dataDir: string;
}

export interface BackupPayload {
  format: typeof FORMAT;
  version: number;
  createdAt: number;
  /** 页面上的浏览器状态：localStorage 里 xf-rine: 开头的那些 */
  local: Record<string, string>;
  server: BackupFiles;
}

export interface BackupEnvelope {
  format: typeof FORMAT;
  version: number;
  createdAt: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-256-GCM'; iv: string; tag: string };
  /** base64 的密文 */
  data: string;
}

const STRATEGIES_PATH = join(HOME_DIR, 'quant-strategies.json');
const AI_STRATEGY_PATH = join(HOME_DIR, 'ai-strategy.json');
const DATA_DIR_PATH = join(HOME_DIR, 'data-dir.json');

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/** 收集服务端这一侧的状态。页面那一侧由调用方填进 local */
export function collectBackup(): BackupFiles {
  return {
    env: readText(ENV_PATH),
    strategies: readText(STRATEGIES_PATH),
    aiStrategy: readText(AI_STRATEGY_PATH),
    dataDir: readText(DATA_DIR_PATH),
  };
}

function assertPassword(password: unknown): string {
  const pw = String(password ?? '');
  if (pw.length < MIN_PASSWORD) {
    throw new BackupError('密码至少 ' + MIN_PASSWORD + ' 位 —— 这个文件里放着 API 密钥，太短等于没加密');
  }
  return pw.normalize('NFKC');
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, KDF_ITERATIONS, 32, 'sha256');
}

export function encryptBackup(
  server: BackupFiles,
  local: Record<string, string>,
  password: unknown,
  now = Date.now(),
): BackupEnvelope {
  const pw = assertPassword(password);
  const payload: BackupPayload = {
    format: FORMAT,
    version: VERSION,
    createdAt: now,
    local,
    server,
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(pw, salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: now,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: salt.toString('base64') },
    cipher: { name: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: body.toString('base64'),
  };
}

export function decryptBackup(envelope: unknown, password: unknown): BackupPayload {
  const env = envelope as Partial<BackupEnvelope> | null;
  if (!env || typeof env !== 'object' || env.format !== FORMAT) {
    throw new BackupError('这不是巡风的备份文件');
  }
  if (Number(env.version) > VERSION) {
    throw new BackupError('这个备份来自更新版本的巡风（v' + env.version + '），先升级程序再恢复');
  }
  const salt = String(env.kdf?.salt ?? '');
  const iv = String(env.cipher?.iv ?? '');
  const tag = String(env.cipher?.tag ?? '');
  const data = String(env.data ?? '');
  if (!salt || !iv || !tag || !data) throw new BackupError('备份文件不完整，缺加密参数');

  const pw = String(password ?? '');
  if (!pw) throw new BackupError('要密码才能解开这个备份');

  let clear: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(pw.normalize('NFKC'), Buffer.from(salt, 'base64')), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    clear = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  } catch {
    // GCM 认证失败不区分「密码错」和「文件被改」—— 两种情况都别往下走
    throw new BackupError('密码不对，或者这个文件被改过');
  }

  let payload: BackupPayload;
  try {
    payload = JSON.parse(clear.toString('utf8')) as BackupPayload;
  } catch {
    throw new BackupError('备份内容读不出来（解密成功但不是有效的数据）');
  }
  if (payload?.format !== FORMAT) throw new BackupError('备份内容的格式不对');
  return payload;
}

/** 写文件前留一份 .bak：恢复错了还能把上一份拿回来 */
function writeWithBackup(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try { copyFileSync(path, path + '.bak'); } catch { /* 留不下就算了，不能因此不恢复 */ }
  }
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
}

/**
 * .env 是「一行一个 键=值」加上注释。
 *
 * 恢复的是文件原文，所以这里只做一件事：确认每一行都长得像配置。
 * 不校验的话，一份被手工改坏的文件会把整个服务端变成读不出配置的状态 ——
 * 那时候连设置页都打不开，只能去翻文件系统。
 */
function assertEnvText(text: string): void {
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    if (!/^[A-Z][A-Z0-9_]*\s*=/.test(s)) {
      throw new BackupError('备份里的配置文件第 ' + (i + 1) + ' 行看不懂：' + s.slice(0, 40));
    }
  }
}

/** 把 .env 的每一行搬进 process.env，再让 config 重读一遍 */
function applyEnvToProcess(text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    process.env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
  reloadConfig();
}

export interface ApplyResult {
  applied: string[];
}

/**
 * 恢复服务端那一半。
 *
 * 顺序有讲究：先写文件、再同步进程内的配置 —— 反过来的话，中间任何一步抛异常，
 * 磁盘上是新的、内存里是旧的，用户看到的和下次启动的会是两套东西。
 */
export function applyBackupFiles(files: Partial<BackupFiles>): ApplyResult {
  const applied: string[] = [];

  if (typeof files.env === 'string' && files.env.trim()) {
    assertEnvText(files.env);
    writeWithBackup(ENV_PATH, files.env.replace(/\r?\n/g, '\n').replace(/\n*$/, '') + '\n');
    applyEnvToProcess(files.env);
    applied.push('密钥与配置');
  }

  if (typeof files.strategies === 'string' && files.strategies.trim()) {
    const parsed = JSON.parse(files.strategies) as { strategies?: unknown };
    if (!Array.isArray(parsed?.strategies)) throw new BackupError('备份里的策略库不是有效格式');
    writeWithBackup(STRATEGIES_PATH, files.strategies);
    applied.push('策略库 ' + parsed.strategies.length + ' 条');
  }

  if (typeof files.aiStrategy === 'string' && files.aiStrategy.trim()) {
    JSON.parse(files.aiStrategy);
    writeWithBackup(AI_STRATEGY_PATH, files.aiStrategy);
    applied.push('AI 交易设置');
  }

  if (typeof files.dataDir === 'string' && files.dataDir.trim()) {
    JSON.parse(files.dataDir);
    writeWithBackup(DATA_DIR_PATH, files.dataDir);
    applied.push('本地数据目录');
  }

  return { applied };
}

/** 页面只允许带回自己的键：备份文件是别人递过来的东西，不能让它写任意 localStorage */
export function sanitizeLocal(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (!k.startsWith('xf-rine:')) continue;
    // 单条 2MB、总共 8MB：localStorage 本身就这么大，超了写回去也会失败
    if (v.length > 2_000_000) continue;
    out[k.slice(0, 200)] = v;
  }
  return out;
}
