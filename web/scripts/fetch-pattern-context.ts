
/**
 * 抓形态条件实验的数据：
 *   · Gate K 线（16 币 × 4h/1d）
 *   · Gate 资金费 + 合约统计（OI / 多空清算 / LSR）
 *   · Binance USDⓈ-M K 线的 taker buy base volume
 *
 *   pnpm fetch:patterns-context
 *   pnpm fetch:patterns-context -- --force --intervals 4h
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { get as httpsGet } from 'node:https';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { fetchGate } from './pattern-core.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const rel = (p: string): string => (isAbsolute(p) ? p : resolve(ROOT, p));
const DEFAULT_SYMBOLS = [
  'BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'DOGE_USDT', 'XRP_USDT', 'BNB_USDT', 'ADA_USDT', 'LINK_USDT',
  'AVAX_USDT', 'DOT_USDT', 'LTC_USDT', 'TRX_USDT', 'ATOM_USDT', 'UNI_USDT', 'FIL_USDT', 'ETC_USDT',
];

interface Options {
  symbols: string[];
  intervals: string[];
  bars: number;
  force: boolean;
  skipBinance: boolean;
  barsDir: string;
  gateDir: string;
  binanceDir: string;
}

function parseArgs(argv: string[]): Options {
  const opt: Options = {
    symbols: DEFAULT_SYMBOLS,
    intervals: ['4h', '1d'],
    bars: 12000,
    force: false,
    skipBinance: false,
    barsDir: ROOT + '.scratch/pattern-context/cache/bars',
    gateDir: ROOT + '.scratch/pattern-context/cache/gate',
    binanceDir: ROOT + '.scratch/pattern-context/cache/binance',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--') continue;
    const next = () => argv[++i] ?? '';
    if (a === '--symbols') opt.symbols = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--intervals') opt.intervals = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--bars') opt.bars = Math.max(500, Number(next()) || 12000);
    else if (a === '--force') opt.force = true;
    else if (a === '--skip-binance') opt.skipBinance = true;
    else if (a === '--bars-dir') opt.barsDir = rel(next());
    else if (a === '--gate-dir') opt.gateDir = rel(next());
    else if (a === '--binance-dir') opt.binanceDir = rel(next());
    else throw new Error('不认识的参数：' + a);
  }
  return opt;
}

function httpsJson(url: string, tries = 2, timeoutMs = 20_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const req = httpsGet(url, { family: 4, headers: { Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          if (left > 0) return attempt(left - 1);
          return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(text)); } catch (e) {
            if (left > 0) attempt(left - 1); else reject(e);
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout ' + url)); });
      req.on('error', (e) => { if (left > 0) attempt(left - 1); else reject(e); });
    };
    attempt(tries);
  });
}

type Rec = { t: number; [k: string]: unknown };

async function paged(label: string, makeUrl: (to?: number) => string, pickTime: (r: any) => number, maxPages = 40): Promise<Rec[]> {
  const out: Rec[] = [];
  const seen = new Set<number>();
  let to: number | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const arr = await httpsJson(makeUrl(to));
    if (!Array.isArray(arr) || arr.length === 0) break;
    let added = 0;
    const times: number[] = [];
    for (const raw of arr) {
      const t = Number(pickTime(raw));
      if (!Number.isFinite(t) || t <= 0) continue;
      times.push(t);
      if (seen.has(t)) continue;
      seen.add(t);
      out.push({ ...raw, t });
      added += 1;
    }
    if (!added || times.length === 0) break;
    const nextTo = Math.min(...times);
    if (!Number.isFinite(nextTo) || nextTo <= 0) break;
    to = nextTo;
  }
  out.sort((a, b) => a.t - b.t);
  console.log('  ' + label + ': ' + out.length + ' 条');
  return out;
}

async function fetchBars(opt: Options): Promise<void> {
  console.log('Gate K 线 → ' + opt.barsDir);
  mkdirSync(opt.barsDir, { recursive: true });
  for (const iv of opt.intervals) {
    for (const sym of opt.symbols) {
      const file = join(opt.barsDir, sym + '_' + iv + '.json');
      if (!opt.force && existsSync(file)) continue;
      try {
        const bars = await fetchGate(sym, iv, opt.bars);
        writeFileSync(file, JSON.stringify(bars));
        console.log('  ' + sym + ' ' + iv + ': ' + bars.length + ' 根');
      } catch (e) {
        console.log('  ' + sym + ' ' + iv + ': 失败 ' + (e as Error).message);
      }
    }
  }
}

async function fetchGateExtras(opt: Options): Promise<void> {
  console.log('Gate 资金费 / 合约统计 → ' + opt.gateDir);
  mkdirSync(opt.gateDir, { recursive: true });
  for (const sym of opt.symbols) {
    const fFile = join(opt.gateDir, sym + '_funding.json');
    if (opt.force || !existsSync(fFile)) {
      try {
        const rows = await paged('funding ' + sym,
          (to) => 'https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=' + encodeURIComponent(sym) + '&limit=1000' + (to ? '&to=' + to : ''),
          (r) => Number(r.t), 40);
        writeFileSync(fFile, JSON.stringify(rows));
      } catch (e) {
        console.log('  funding ' + sym + ': 失败 ' + (e as Error).message);
      }
    }
    for (const iv of opt.intervals) {
      const sFile = join(opt.gateDir, sym + '_stats_' + iv + '.json');
      if (!opt.force && existsSync(sFile)) continue;
      try {
        const rows = await paged('stats ' + sym + ' ' + iv,
          (to) => 'https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=' + encodeURIComponent(sym) + '&interval=' + iv + '&limit=1000' + (to ? '&to=' + to : ''),
          (r) => Number(r.time ?? r.t), 30);
        writeFileSync(sFile, JSON.stringify(rows));
      } catch (e) {
        console.log('  stats ' + sym + ' ' + iv + ': 失败 ' + (e as Error).message);
      }
    }
  }
}

async function fetchBinance(opt: Options): Promise<void> {
  if (opt.skipBinance) {
    console.log('跳过 Binance（--skip-binance）');
    return;
  }
  console.log('Binance taker buy → ' + opt.binanceDir);
  mkdirSync(opt.binanceDir, { recursive: true });
  try {
    await httpsJson('https://fapi.binance.com/fapi/v1/ping', 1, 10_000);
  } catch {
    console.log('  Binance 不可达（可能需要代理/VPN），跳过。已有缓存仍可跑 --feature flow。');
    return;
  }
  for (const sym of opt.symbols) {
    const bSym = sym.replace('_USDT', 'USDT');
    for (const iv of opt.intervals) {
      const file = join(opt.binanceDir, sym + '_' + iv + '.json');
      if (!opt.force && existsSync(file)) continue;
      const rows: any[] = [];
      let start = Date.UTC(2019, 0, 1);
      try {
        for (let page = 0; page < 40; page += 1) {
          const url = 'https://fapi.binance.com/fapi/v1/klines?symbol=' + bSym + '&interval=' + iv + '&limit=1500&startTime=' + start;
          const arr = await httpsJson(url);
          if (!Array.isArray(arr) || arr.length === 0) break;
          let last = 0;
          for (const k of arr) {
            const ms = Number(k[0]);
            if (!Number.isFinite(ms)) continue;
            last = Math.max(last, ms);
            rows.push({
              time: ms / 1000, open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
              volume: Number(k[5]), quoteVolume: Number(k[7]), trades: Number(k[8]), takerBuy: Number(k[9]),
            });
          }
          if (!last || arr.length < 1500) break;
          start = last + 1;
        }
        writeFileSync(file, JSON.stringify(rows));
        const tb = rows.filter((r) => r.takerBuy > 0).length;
        console.log('  ' + sym + ' ' + iv + ': ' + rows.length + ' 根，takerBuy>0 ' + tb);
      } catch (e) {
        console.log('  ' + sym + ' ' + iv + ': 失败 ' + (e as Error).message);
      }
    }
  }
}

async function main(): Promise<void> {
  const opt = parseArgs(process.argv.slice(2));
  await fetchBars(opt);
  await fetchGateExtras(opt);
  await fetchBinance(opt);
  console.log('完成。关键位时间线：python sidecar/scripts/export_levels_timeline.py');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
