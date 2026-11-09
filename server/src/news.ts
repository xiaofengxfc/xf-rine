/**
 * 币种新闻雷达。
 *
 * 抓公开 RSS，按合约挑出相关的新闻，再用一份看涨/看跌词表算情绪分。
 * 不引第三方依赖，也不需要任何 API key。
 */

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  score: number;
  sentiment: number;
  matched: string[];
}

export interface FeedStat {
  name: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface NewsDigest {
  contract: string;
  base: string;
  fetchedAt: number;
  items: NewsItem[];
  feeds: FeedStat[];
  sentiment: number;
  stance: 'bullish' | 'neutral' | 'bearish';
  note: string;
}

interface RawItem {
  title: string;
  desc: string;
  url: string;
  source: string;
  publishedAt: number;
}

const FEEDS: { name: string; url: string }[] = [
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/' },
  { name: 'CoinJournal', url: 'https://coinjournal.net/feed/' },
];

const CACHE_TTL_MS = 12 * 60 * 1000;

// ---------- RSS 解析 ----------

function stripXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m?.[1] ? stripXml(m[1]) : '';
}

function linkOf(block: string): string {
  const direct = tag(block, 'link');
  if (direct) return direct;
  // Atom 的 <link href="..."/>
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  return m?.[1] ? m[1].trim() : '';
}

function parseFeed(xml: string, source: string): RawItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: RawItem[] = [];
  for (const block of blocks) {
    const title = tag(block, 'title');
    if (!title) continue;
    const raw = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date');
    const at = raw ? Date.parse(raw) : Number.NaN;
    out.push({
      title,
      desc: tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'),
      url: linkOf(block),
      source,
      publishedAt: Number.isFinite(at) ? at : Date.now(),
    });
  }
  return out;
}

async function fetchFeed(feed: { name: string; url: string }): Promise<{ items: RawItem[]; stat: FeedStat }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(feed.url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; xf-rine/1.0)', accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (!res.ok) return { items: [], stat: { name: feed.name, ok: false, count: 0, error: `HTTP ${res.status}` } };
    const items = parseFeed(await res.text(), feed.name);
    return { items, stat: { name: feed.name, ok: true, count: items.length } };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '超时' : e.message) : String(e);
    return { items: [], stat: { name: feed.name, ok: false, count: 0, error: msg.slice(0, 60) } };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 缓存 ----------

let cache: { at: number; items: RawItem[]; feeds: FeedStat[] } | null = null;
let inflight: Promise<{ items: RawItem[]; feeds: FeedStat[] }> | null = null;

async function loadFeeds(): Promise<{ items: RawItem[]; feeds: FeedStat[] }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const results = await Promise.all(FEEDS.map(fetchFeed));
    const items = results.flatMap((r) => r.items);
    const feeds = results.map((r) => r.stat);
    // 一个源都没抓到时不要把空结果缓存 12 分钟
    if (items.length > 0) cache = { at: Date.now(), items, feeds };
    return { items, feeds };
  })().finally(() => { inflight = null; });
  return inflight;
}

// ---------- 币种关键词 ----------

interface Words { cs: string[]; ci: string[] }

const COIN_WORDS: Record<string, Words> = {
  BTC: { cs: ['BTC'], ci: ['bitcoin', '比特币'] },
  ETH: { cs: ['ETH', 'ETH2'], ci: ['ethereum', 'ether', '以太坊', 'vitalik'] },
  SOL: { cs: ['SOL'], ci: ['solana'] },
  XRP: { cs: ['XRP'], ci: ['ripple'] },
  DOGE: { cs: ['DOGE'], ci: ['dogecoin', 'shiba inu moon'] },
  BNB: { cs: ['BNB'], ci: ['binance coin', 'binance smart chain'] },
  ADA: { cs: ['ADA'], ci: ['cardano'] },
  AVAX: { cs: ['AVAX'], ci: ['avalanche'] },
  LINK: { cs: ['LINK'], ci: ['chainlink'] },
  TON: { cs: ['TON'], ci: ['toncoin', 'telegram wallet'] },
  TRX: { cs: ['TRX'], ci: ['tron'] },
  LTC: { cs: ['LTC'], ci: ['litecoin'] },
  BCH: { cs: ['BCH'], ci: ['bitcoin cash'] },
  DOT: { cs: ['DOT'], ci: ['polkadot'] },
  SUI: { cs: ['SUI'], ci: ['sui network'] },
  APT: { cs: ['APT'], ci: ['aptos'] },
  ARB: { cs: ['ARB'], ci: ['arbitrum'] },
  OP: { cs: ['OP'], ci: ['optimism'] },
  NEAR: { cs: ['NEAR'], ci: ['near protocol'] },
  ATOM: { cs: ['ATOM'], ci: ['cosmos'] },
  PEPE: { cs: ['PEPE'], ci: ['pepe coin'] },
  SHIB: { cs: ['SHIB'], ci: ['shiba inu'] },
  XAU: { cs: ['XAU'], ci: ['gold', '黄金'] },
  XAG: { cs: ['XAG'], ci: ['silver', '白银'] },
};

function wordsFor(contract: string): { base: string; words: Words } {
  const base = contract.split('_')[0]!.toUpperCase();
  return { base, words: COIN_WORDS[base] ?? { cs: [base], ci: [] } };
}

function countHits(text: string, words: Words): string[] {
  const hits: string[] = [];
  for (const w of words.cs) {
    if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) hits.push(w);
  }
  const lower = text.toLowerCase();
  for (const w of words.ci) if (lower.includes(w.toLowerCase())) hits.push(w);
  return hits;
}

// ---------- 情绪词典 ----------

const BULLISH = [
  'surge', 'soar', 'rally', 'jump', 'gain', 'rise', 'climb', 'breakout', 'record', 'rebound',
  'bullish', 'adoption', 'approval', 'upgrade', 'partnership', 'inflow', 'accumulate', 'optimistic',
  'all-time high', 'ath', 'boost', 'pump', 'buyback', 'etf approval', 'institutional',
];

const BEARISH = [
  'plunge', 'crash', 'drop', 'fall', 'slump', 'tumble', 'decline', 'sink', 'selloff', 'sell-off',
  'bearish', 'hack', 'exploit', 'lawsuit', 'sue', 'charges', 'fraud', 'scam', 'ban', 'outflow',
  'liquidation', 'delist', 'warning', 'fear', 'correction', 'downside', 'slashes', 'probe',
];

const NEGATORS = ['not', "n't", 'no', 'never', 'without', 'denies', 'deny'];

function sentimentOf(text: string): number {
  const lower = ` ${text.toLowerCase()} `;
  let score = 0;
  for (const w of BULLISH) if (lower.includes(w)) score += 1;
  for (const w of BEARISH) if (lower.includes(w)) score -= 1;
  if (score === 0) return 0;
  // 简单否定处理：命中数量有限，按窗口内出现否定词就反向
  const negated = NEGATORS.some((n) => lower.includes(` ${n} `));
  const signed = negated ? -score : score;
  return Math.max(-1, Math.min(1, signed / 3));
}

// ---------- 组装 ----------

function recencyWeight(publishedAt: number, now: number): number {
  const hours = Math.max(0, (now - publishedAt) / 3_600_000);
  if (hours <= 6) return 1;
  if (hours <= 24) return 0.85;
  if (hours <= 72) return 0.6;
  return 0.35;
}

export async function newsDigest(contract: string, limit = 8): Promise<NewsDigest> {
  const { base, words } = wordsFor(contract);
  const { items: all, feeds } = await loadFeeds();
  const now = Date.now();

  const scored: NewsItem[] = [];
  for (const it of all) {
    const inTitle = countHits(it.title, words);
    const inDesc = countHits(it.desc.slice(0, 400), words);
    if (inTitle.length === 0 && inDesc.length === 0) continue;
    const raw = inTitle.length * 3 + inDesc.length;
    scored.push({
      title: it.title,
      url: it.url,
      source: it.source,
      publishedAt: it.publishedAt,
      score: Number((raw * recencyWeight(it.publishedAt, now)).toFixed(2)),
      sentiment: sentimentOf(`${it.title}. ${it.desc.slice(0, 200)}`),
      matched: [...new Set([...inTitle, ...inDesc])],
    });
  }

  scored.sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt);
  const items = scored.slice(0, limit);

  const totalWeight = items.reduce((s, i) => s + i.score, 0);
  const sentiment = totalWeight > 0
    ? Number((items.reduce((s, i) => s + i.sentiment * i.score, 0) / totalWeight).toFixed(3))
    : 0;

  const stance: NewsDigest['stance'] = sentiment >= 0.15 ? 'bullish' : sentiment <= -0.15 ? 'bearish' : 'neutral';
  const note = items.length === 0
    ? `没有找到与 ${base} 相关的新闻。冷门合约本来就没有媒体覆盖，这是正常的。`
    : `最近 72 小时内 ${items.length} 条相关报道，情绪加权 ${sentiment.toFixed(2)}。`;

  return {
    contract,
    base,
    fetchedAt: cache?.at ?? now,
    items,
    feeds,
    sentiment,
    stance,
    note,
  };
}
