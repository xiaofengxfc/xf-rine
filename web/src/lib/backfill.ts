/**
 * 往前补历史。
 *
 * 以前由拖动事件驱动：拖一下补一页，补完就停。用户不动，历史就一直停在原地。
 * 这里改成自己一路补到底，拖动只是再催一次。
 *
 * 三种情况收工：交易所那头没有了、到本地上限、调用方要求停（切币种、卸载）。
 * 失败按退避重试，重试完还不行就停手 —— 一次网络抖动不该让这条时间轴不再加载。
 */
import type { Bar } from './api.ts';
import { mergeOlder } from './candles.ts';

export interface OlderPage {
  bars: Bar[];
  /** 交易所那头没有更早的了 */
  exhausted: boolean;
}

export type BackfillStop =
  /** 交易所到头 */
  | 'exhausted'
  /** 到本地上限 */
  | 'full'
  /** 调用方要求停 */
  | 'aborted'
  /** 连续失败，放弃这一轮 */
  | 'error'
  /** 上游一直给重复的页，没有进展 */
  | 'nopage'
  /** 补到单轮页数上限 */
  | 'pagelimit';

export interface BackfillOptions {
  /** 手上这一段，按时间升序 */
  bars: Bar[];
  /** 本地最多留多少根 */
  maxBars: number;
  /** 要早于 before 的一页 */
  fetchPage: (before: number) => Promise<OlderPage>;
  /** 并进一页就回调，界面可以增量刷新 */
  onPage?: (bars: Bar[], added: number) => void;
  /** 每轮问一次，返回 true 就停 */
  shouldStop?: () => boolean;
  /** 连续失败几次放弃 */
  maxRetries?: number;
  /** 上游一直不往前走时最多重试几次 */
  maxStall?: number;
  /** 单轮最多补几页 */
  maxPages?: number;
  /** 每次失败通知一次，调用方决定要不要提示 */
  onError?: (err: unknown) => void;
  /** 重试前等多久。测试可以传一个立即返回的 */
  sleep?: (ms: number) => Promise<void>;
}

export interface BackfillResult {
  bars: Bar[];
  /** 交易所到头了 */
  exhausted: boolean;
  /** 真的补进来几页 */
  pages: number;
  stopped: BackfillStop;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

export async function backfill(opts: BackfillOptions): Promise<BackfillResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const maxStall = opts.maxStall ?? 2;
  const maxPages = opts.maxPages ?? 40;
  const sleep = opts.sleep ?? defaultSleep;

  let bars = opts.bars;
  let pages = 0;
  let retries = 0;
  let stalls = 0;

  const out = (stopped: BackfillStop, exhausted = false): BackfillResult =>
    ({ bars, exhausted, pages, stopped });

  for (;;) {
    if (opts.shouldStop?.()) return out('aborted');
    if (bars.length === 0) return out('nopage');
    if (bars.length >= opts.maxBars) return out('full');
    if (pages >= maxPages) return out('pagelimit');

    let page: OlderPage;
    try {
      page = await opts.fetchPage(bars[0]!.time);
      retries = 0;
    } catch (err) {
      retries += 1;
      opts.onError?.(err);
      if (retries > maxRetries) return out('error');
      await sleep(300 * 2 ** (retries - 1));
      continue;
    }

    const merged = mergeOlder(bars, page.bars, opts.maxBars);
    // 到头这一页也可能还带几根，先并进来再收工
    if (merged.bars !== bars) {
      bars = merged.bars;
      opts.onPage?.(bars, merged.added);
    }
    if (page.exhausted) return out('exhausted', true);
    if (merged.full) return out('full');
    if (merged.duplicate) {
      stalls += 1;
      if (stalls > maxStall) return out('nopage');
      await sleep(200 * stalls);
      continue;
    }
    pages += 1;
    stalls = 0;
  }
}
