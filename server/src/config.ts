import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

declare const __dirname: string;

/**
 * 这个文件所在的目录。
 *
 * 开发时是 tsx 跑 ES 模块，import.meta.url 有值。
 * 桌面端把整个服务端打成一个 .cjs 再跑，那里没有 import.meta，只有 __dirname。
 * 两个都拿不到就退回当前工作目录 —— 打包后的入口一定会用 XFRINE_HOME 把这两条兜住，
 * 这里只是为了别在极端情况下直接抛异常。
 */
export function moduleDir(): string {
  try {
    const url = import.meta.url;
    if (url) return dirname(fileURLToPath(url));
  } catch { /* 打包成 CJS 之后没有 import.meta */ }
  try {
    return __dirname;
  } catch { /* ESM 下没有 __dirname */ }
  return process.cwd();
}

/**
 * .env 放在哪。
 *
 * 开发时就是 server/.env，README 一直这么写。
 * 装到 Program Files 之后那个目录是只读的，写密钥会直接 EPERM ——
 * 所以桌面端把 XFRINE_HOME 指到用户目录（%APPDATA%\巡风），
 * 升级、卸载都不会把密钥带走。
 */
export const HOME_DIR = (process.env.XFRINE_HOME ?? '').trim() || resolve(moduleDir(), '..');
export const ENV_PATH = join(HOME_DIR, '.env');

// dotenv 原来靠 import 'dotenv/config'，它只认进程当前目录下的 .env。
// 桌面端的当前目录是安装目录或者快捷方式的起始位置，读不到用户目录里那份，
// 于是设置页里存进去的密钥看起来「保存成功但没生效」。这里显式指定路径。
dotenv.config({ path: ENV_PATH });

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export type GateEnv = 'testnet' | 'live';

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Config {
  env: GateEnv;
  key: string;
  secret: string;
  liveTrading: boolean;
  port: number;
  /** 监听地址。默认只听本机；要拿手机连就设成 0.0.0.0 */
  host: string;
  /** 手机访问的口令。绑在 0.0.0.0 上时必须设，否则整栋楼都能下单 */
  remoteToken: string;
  ai: AiConfig;
}

/** 每个环境一套密钥，切环境不用重填。GATE_KEY/GATE_SECRET 作为兜底的老写法保留。 */
export function keySlot(env: GateEnv): { key: string; secret: string } {
  const suffix = env === 'testnet' ? 'TESTNET' : 'LIVE';
  return { key: `GATE_${suffix}_KEY`, secret: `GATE_${suffix}_SECRET` };
}

/** 读指定环境的密钥。不传就读当前环境。 */
export function readKey(env: GateEnv = config.env): string {
  const slot = keySlot(env);
  return (process.env[slot.key] ?? process.env.GATE_KEY ?? '').trim();
}

function readSecret(env: GateEnv): string {
  const slot = keySlot(env);
  return (process.env[slot.secret] ?? process.env.GATE_SECRET ?? '').trim();
}

function maskKey(k: string): { configured: boolean; hint: string } {
  if (!k) return { configured: false, hint: '' };
  return { configured: true, hint: k.length <= 8 ? '••••' : `${'•'.repeat(4)}${k.slice(-4)}` };
}

export const AI_DEFAULT_BASE = 'https://api.openai.com/v1';
export const AI_DEFAULT_MODEL = 'gpt-4o-mini';

function readConfig(): Config {
  const env: GateEnv = (process.env.GATE_ENV ?? 'live').trim().toLowerCase() === 'testnet' ? 'testnet' : 'live';
  return {
    env,
    key: readKey(env),
    secret: readSecret(env),
    liveTrading: (process.env.LIVE_TRADING ?? 'false').trim().toLowerCase() === 'true',
    port: num(process.env.PORT, 8787),
    host: (process.env.HOST ?? '').trim() || '127.0.0.1',
    remoteToken: (process.env.REMOTE_TOKEN ?? '').trim(),
    ai: {
      baseUrl: (process.env.AI_BASE_URL ?? AI_DEFAULT_BASE).trim(),
      apiKey: (process.env.AI_API_KEY ?? '').trim(),
      model: (process.env.AI_MODEL ?? '').trim() || AI_DEFAULT_MODEL,
    },
  };
}

export let config: Config = readConfig();

export function reloadConfig(): Config {
  config = readConfig();
  return config;
}

const REST_ORIGIN: Record<GateEnv, string> = {
  live: 'https://api.gateio.ws',
  testnet: 'https://api-testnet.gateapi.io',
};

/** 账户、持仓、下单走这里：模拟盘打测试网，实盘打主网 */
export function restBaseUrl(): string {
  return REST_ORIGIN[config.env];
}

/**
 * 公共行情永远走主网。
 * 测试网的行情是编造的历史数据（BTC 24h 成交量能报到 880 亿 U），
 * K 线和成交额都不能用来做技术分析。只有账户和交易才需要用测试网。
 */
export function publicBaseUrl(): string {
  return REST_ORIGIN.live;
}

/**
 * 行情 WebSocket 一律连主网。
 * 测试网没有公共行情连接（fx-ws-testnet 与 ws-testnet 都连不上），
 * 而测试网 REST 的公开行情本来就是主网价格的镜像，两边价格一致。
 */
export function marketWsUrl(): string {
  return 'wss://fx-ws.gateio.ws/v4/ws/usdt';
}

export function envLabel(): string {
  return config.env === 'testnet' ? '模拟盘' : '实盘';
}

/** 页面只能看到尾号，密钥永不出网 */
export function keyHint(): { configured: boolean; hint: string } {
  return maskKey(config.key);
}

/** 两个环境各自的配置状态，设置页要一次看到两套 */
export function keyHintFor(env: GateEnv): { configured: boolean; hint: string } {
  return maskKey(readKey(env));
}

/**
 * 把用户填的地址补成完整的 chat/completions 端点。
 *
 * 中转站写法五花八门，三种都认：
 *   https://x.com/v1              → https://x.com/v1/chat/completions
 *   https://x.com                 → https://x.com/v1/chat/completions
 *   https://x.com/v1/chat/completions → 原样用
 */
export function aiEndpoint(baseUrl: string = config.ai.baseUrl): string {
  const base = (baseUrl || AI_DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+[a-z0-9]*$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** 同一个 base 地址下的模型列表端点：把 chat/completions 换成 models */
export function aiModelsEndpoint(baseUrl: string = config.ai.baseUrl): string {
  return aiEndpoint(baseUrl).replace(/\/chat\/completions$/, '/models');
}

/** AI 密钥同样只回显尾号 */
export function aiKeyHint(): { configured: boolean; hint: string } {
  const k = config.ai.apiKey;
  if (!k) return { configured: false, hint: '' };
  return { configured: true, hint: k.length <= 8 ? '••••' : `${'•'.repeat(4)}${k.slice(-4)}` };
}

/** 只听本机的时候，这套服务端就只服务这一台电脑 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** 绑在 0.0.0.0 上才算「给手机开了门」 */
export function lanEnabled(): boolean {
  return !isLoopbackHost(config.host);
}

/** 这台机器在局域网里的地址，手机端要填的就是它 */
export function lanUrls(port: number = config.port): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) out.push('http://' + n.address + ':' + port);
    }
  }
  return out;
}

/**
 * 手机访问要填的东西。
 * 口令只在本机显示 —— 页面既然是从本机打开的，说明已经拿到这台机器了；
 * 从别处连过来的请求一律看不到口令。
 */
export function remoteAccess(): { enabled: boolean; host: string; urls: string[]; token: string | null } {
  return {
    enabled: lanEnabled(),
    host: config.host,
    urls: lanUrls(),
    token: config.remoteToken || null,
  };
}

/**
 * 设置页写入密钥。只写 GATE_KEY / GATE_SECRET / LIVE_TRADING，其它行原样保留。
 */
export function writeEnv(patch: Record<string, string>): void {
  // 第一次运行的时候用户目录里什么都还没有，writeFileSync 不会替我们建目录
  mkdirSync(dirname(ENV_PATH), { recursive: true });
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out = current.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!m) return line;
    const name = m[1]!;
    if (!(name in patch)) return line;
    seen.add(name);
    return `${name}=${patch[name]}`;
  });
  for (const [k, v] of Object.entries(patch)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  writeFileSync(ENV_PATH, out.join('\n').replace(/\n+$/, '') + '\n', 'utf8');
  // dotenv 只在启动时读过一次文件，之后写进去的值进不了 process.env。
  // 不手动同步的话 reloadConfig() 读到的还是旧值：保存返回成功、文件也变了，
  // 但进程里一点没动，必须重启才生效。
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  reloadConfig();
}
