import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = resolve(here, '../.env');

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

/**
 * 设置页写入密钥。只写 GATE_KEY / GATE_SECRET / LIVE_TRADING，其它行原样保留。
 */
export function writeEnv(patch: Record<string, string>): void {
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
