import { useEffect, useMemo, useRef, useState } from 'react';
import type { Ticker } from '../lib/api.ts';
import { compact, fmtPct, fmtPrice } from '../lib/format.ts';

interface Props {
  tickers: Ticker[];
  current: string;
  onSelect: (name: string) => void;
  /** 模拟盘才需要标「哪个能下单」；实盘全是能交易的，标了反而吵 */
  showTradable?: boolean;
  /** 窄屏下左栏是抽屉，给一个明确的收起按钮（点遮罩也能收，但那得有猜的胆量） */
  onClose?: () => void;
}

type Tab = 'all' | 'up' | 'down';

const RAIL_KEY = 'xf-rine:rail';

/** 上次停在哪个页签、搜了什么、列表滚到哪 —— 刷新后接着看，别每次都弹回「全部」 */
function readRail(): { q: string; tab: Tab; scroll: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(RAIL_KEY) ?? '{}') as Record<string, unknown>;
    const tab = raw.tab === 'up' || raw.tab === 'down' ? raw.tab : 'all';
    return {
      q: typeof raw.q === 'string' ? raw.q.slice(0, 32) : '',
      tab,
      scroll: typeof raw.scroll === 'number' && raw.scroll > 0 ? raw.scroll : 0,
    };
  } catch {
    return { q: '', tab: 'all', scroll: 0 };
  }
}

function saveRail(v: { q: string; tab: Tab; scroll: number }): void {
  try { localStorage.setItem(RAIL_KEY, JSON.stringify(v)); } catch { /* 存不了就算了 */ }
}

export default function ContractRail({ tickers, current, onSelect, showTradable = false, onClose }: Props) {
  const rail0 = useRef(readRail()).current;
  const [q, setQ] = useState(rail0.q);
  const [tab, setTab] = useState<Tab>(rail0.tab);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef(rail0.scroll);
  const restoredRef = useRef(false);

  const rows = useMemo(() => {
    const needle = q.trim().toUpperCase();
    let list = tickers;
    if (needle) list = list.filter((t) => t.contract.includes(needle));
    if (tab === 'up') list = list.filter((t) => t.change24h > 0).sort((a, b) => b.change24h - a.change24h);
    if (tab === 'down') list = list.filter((t) => t.change24h < 0).sort((a, b) => a.change24h - b.change24h);
    // 正在看的那个币可能被这 120 行挤掉，栏里就没有高亮了。
    // 试过把它钉到最前面，但那会打乱「跌幅榜」的排序，扫一眼就乱了，所以不钉。
    return list.slice(0, 120);
  }, [tickers, q, tab]);

  useEffect(() => { saveRail({ q, tab, scroll: scrollRef.current }); }, [q, tab]);

  // 列表第一次真正有行的时候再把滚动位置还回去。
  // 注意必须等 rows 有内容：容器先渲染、行情后到，在没有行的时候设 scrollTop
  // 会被夹成 0，等于白设。
  useEffect(() => {
    if (restoredRef.current) return;
    const el = listRef.current;
    if (!el || rows.length === 0) return;
    restoredRef.current = true;
    if (scrollRef.current > 0) el.scrollTop = scrollRef.current;
  }, [rows.length]);

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="rail-head-row">
          <input
            className="search"
            placeholder="搜索合约 · BTC / ETH…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
          />
          {onClose && <button className="rail-close" title="收起" aria-label="收起合约列表" onClick={onClose}>×</button>}
        </div>
        <div className="rail-tabs">
          <button className={`rail-tab ${tab === 'all' ? 'on' : ''}`} onClick={() => setTab('all')}>全部</button>
          <button className={`rail-tab ${tab === 'up' ? 'on' : ''}`} onClick={() => setTab('up')}>涨</button>
          <button className={`rail-tab ${tab === 'down' ? 'on' : ''}`} onClick={() => setTab('down')}>跌</button>
        </div>
      </div>
      <div
        className="sym-list"
        ref={listRef}
        onScroll={(e) => {
          scrollRef.current = (e.target as HTMLDivElement).scrollTop;
          saveRail({ q, tab, scroll: scrollRef.current });
        }}
      >
        {rows.length === 0 && <div className="empty">没有匹配的合约</div>}
        {rows.map((t) => (
          <button
            key={t.contract}
            className={`sym ${t.contract === current ? 'on' : ''}${showTradable && t.tradable ? ' ok' : ''}`}
            onClick={() => onSelect(t.contract)}
            title={t.tradable === false ? '模拟盘没有这个合约：图能看，单下不了' : undefined}
          >
            <span className="n">
              {t.contract.replace('_USDT', '')}<em> /USDT</em>
            </span>
            <span className="p num">{fmtPrice(t.last, t.last >= 1000 ? 0.1 : 0.0001)}</span>
            <span className="c num dim">{compact(t.volume24hUsd)}</span>
            <span className={`c num ${t.change24h >= 0 ? 'up' : 'down'}`}>{fmtPct(t.change24h, 2)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
