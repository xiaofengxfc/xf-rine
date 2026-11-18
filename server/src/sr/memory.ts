import type { Zone } from './types.js';

/**
 * 档位记忆。
 *
 * 引擎每次都是「拿最近 N 根重算一遍」：窗口往前滚一根，聚类中心就跟着挪几美元。
 * 页面上看到的就是支撑阻力线一直在小幅跳，角色也贴着现价来回翻；而且引擎只给
 * 当前这几个位，旧的线到点就整条消失，人记不住它刚才在哪。
 *
 * 这里把「线」和「价」分开处理：
 *
 *   1. **认得出同一个位**：新中心和记住的那个差不到 0.35 个 ATR，就当同一个位，
 *      位置钉在记忆里那个中心上。线因此不再随每次重算漂移。
 *   2. **角色带迟滞**：现价要穿过这条带的外沿、再走 0.25 个 ATR，才把支撑压强翻成
 *      压力/支撑。贴着边界来回穿越时角色不再三秒一变。
 *   3. **留得住历史**：这次没算出来的位不立刻删，先留成 history 返回，页面画淡一点。
 *      等它离现价超过 6 个 ATR、或者放满 48 小时，才真丢掉。
 *
 * 概率（触及 / 守住）做指数平滑：模型输出逐次抖两三个百分点没有意义，
 * 只会让图上那行字跟着闪。
 */

export interface ZoneMemoryOptions {
  /** 当前波动幅度，决定「同一个位」和「真突破」的尺度 */
  atr: number;
  /** 现价 */
  live: number;
  now?: number;
  /** 历史位最长留多久 */
  ttlMs?: number;
  /** 最多留几条历史位 */
  maxHistory?: number;
}

export interface ZoneSet {
  /** 这次算出来、并且位置已经钉住的位 */
  current: Array<Zone & { history?: boolean }>;
  /** 之前出现过、这次没算出来的位，前端画淡一点 */
  history: Array<Zone & { history?: boolean }>;
}

interface Remembered extends Zone {
  firstSeen: number;
  lastSeen: number;
  hits: number;
}

const DEFAULT_TTL_MS = 48 * 3600_000;
const MAX_HISTORY = 6;
/** 同一个位：中心相差 0.35 个 ATR 以内 */
const MATCH_ATR = 0.35;
/** 真突破：穿过这条带的外沿之后还要再走 0.25 个 ATR */
const BREAK_ATR = 0.25;
/** 现价离这条位超过 6 个 ATR，它对当下就没用了 */
const FORGET_ATR = 6;

const book = new Map<string, Remembered[]>();

/** ATR 拿不到时退到 0.3% 的价格跨度：0 会让任何两条线都判成同一个位 */
function unitOf(atr: number, live: number): number {
  if (atr > 0) return atr;
  if (live > 0) return Math.max(live * 0.003, 1e-9);
  // 价格也没有（数据没到位）：给个 1，至少不会让所有位都被认成同一个
  return 1;
}

function smooth(oldV: number | null, newV: number | null): number | null {
  if (newV === null || !Number.isFinite(newV)) return oldV;
  if (oldV === null || !Number.isFinite(oldV)) return newV;
  return Number((oldV * 0.6 + newV * 0.4).toFixed(4));
}

/** 角色：只有明确穿过外沿才翻，否则保持上一次的判断 */
function roleOf(z: Zone, live: number, breakAtr: number, prev: 'support' | 'resistance' | null): Zone['zone_type'] {
  // 拿不到现价就别猜：以前那个「按价格硬判」的写法在 live=0 时会把所有位都判成压力
  if (!(live > 0)) return prev ?? z.zone_type;
  if (live > z.high + breakAtr) return 'support';
  if (live < z.low - breakAtr) return 'resistance';
  return prev ?? z.zone_type;
}

/** 距离永远按当前价格现算：它描述的是「离现在多远」，不该被记住 */
function withDistance(z: Zone, live: number, atr: number, role: Zone['zone_type']): Zone {
  const a = atr > 0 ? atr : 0;
  // 没有现价就没有「多远」这回事：保留引擎给的距离，别写成 NaN 或 0
  if (!(live > 0)) {
    return { ...z, zone_type: role, zone_label: role === 'support' ? '支撑带' : '压力带' };
  }
  return {
    ...z,
    zone_type: role,
    zone_label: role === 'support' ? '支撑带' : '压力带',
    distance_pct: Number((((z.center - live) / live) * 100).toFixed(4)),
    distance_atr: a > 0 ? Number(((z.center - live) / a).toFixed(4)) : z.distance_atr,
  };
}

/**
 * 把这次算出来的档位并进记忆，返回这次该画的东西。
 *
 * key 要能区分合约、周期和请求口径（方向、每侧几个位）—— 口径不同的两次计算
 * 本来就不是同一批位，混在一起会互相把对方的中心钉歪。
 */
export function stabilizeZones(key: string, fresh: Zone[], opts: ZoneMemoryOptions): ZoneSet {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxHistory = opts.maxHistory ?? MAX_HISTORY;
  const live = opts.live;
  const unit = unitOf(opts.atr, live);
  const matchD = unit * MATCH_ATR;
  const breakAtr = unit * BREAK_ATR;

  const prev = book.get(key) ?? [];
  const claimed = new Set<Remembered>();
  const current: Array<Zone & { history?: boolean }> = [];

  for (const z of fresh) {
    let best: Remembered | null = null;
    let bestD = Infinity;
    for (const old of prev) {
      if (claimed.has(old)) continue;
      const d = Math.abs(old.center - z.center);
      if (d <= matchD && d < bestD) { best = old; bestD = d; }
    }

    if (!best) {
      // 真新的一条位：从这次开始记
      const created: Remembered = { ...z, firstSeen: now, lastSeen: now, hits: 1 };
      claimed.add(created);
      prev.push(created);
      const role = roleOf(created, live, breakAtr, null);
      current.push(withDistance({ ...created, history: false }, live, opts.atr, role));
      continue;
    }

    claimed.add(best);
    best.hits += 1;
    best.lastSeen = now;
    // 位置和宽度钉住不动，只让概率和统计往前走
    best.p_touch = smooth(best.p_touch, z.p_touch);
    best.p_hold = smooth(best.p_hold, z.p_hold);
    best.p_effective = smooth(best.p_effective, z.p_effective);
    best.n_events = z.n_events;
    best.tf_count = z.tf_count;
    best.tfs = z.tfs;
    best.edge_score = z.edge_score;
    best.vp_strength = z.vp_strength;
    best.bucket = z.bucket;
    best.bucket_hold_rate = z.bucket_hold_rate;
    best.bucket_fwd_ret = z.bucket_fwd_ret;
    best.bucket_n = z.bucket_n;
    const role = roleOf(best, live, breakAtr, best.zone_type);
    current.push(withDistance({ ...best, history: false }, live, opts.atr, role));
  }

  /**
   * 这次没算出来的旧位。
   *
   * 现价已经走远、或者放太久，就真丢掉（留着只会把图压满）；
   * 其余的留成历史，页面画淡一点 —— 「刚才那条支撑去哪了」这个问号就是靠它消掉的。
   */
  const history: Array<Zone & { history?: boolean }> = [];
  const kept: Remembered[] = [];
  for (const old of prev) {
    if (claimed.has(old)) { kept.push(old); continue; }
    if (now - old.lastSeen > ttl) continue;
    if (Math.abs(old.center - live) > unit * FORGET_ATR) continue;
    kept.push(old);
    const role = roleOf(old, live, breakAtr, old.zone_type);
    history.push(withDistance({ ...old, history: true }, live, opts.atr, role));
  }

  history.sort((a, b) => Math.abs(a.center - live) - Math.abs(b.center - live));
  const trimmed = history.slice(0, maxHistory);
  if (trimmed.length < history.length) {
    const shown = new Set(trimmed.map((z) => z.center));
    for (const old of [...kept]) {
      if (!claimed.has(old) && !shown.has(old.center)) kept.splice(kept.indexOf(old), 1);
    }
  }

  book.set(key, kept);

  // 一个 key 上堆了几十条位，说明这个合约换过好几个区间，顺手清一下死掉的
  if (kept.length > 40) {
    book.set(key, kept.filter((o) => now - o.lastSeen <= ttl).slice(-40));
  }

  return { current, history: trimmed };
}

/** 键：交易所 + 合约 + 周期 + 请求口径 */
export function zoneKey(exchange: string, symbol: string, tf: string, dir: string, n: number): string {
  return exchange + ':' + symbol + ':' + tf + ':' + dir + ':' + n;
}

/** 切交易所或测试时清空 */
export function resetZoneMemory(): void {
  book.clear();
}
