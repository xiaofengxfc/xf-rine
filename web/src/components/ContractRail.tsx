import { useMemo, useState } from 'react';
import type { Ticker } from '../lib/api.ts';
import { compact, fmtPct, fmtPrice } from '../lib/format.ts';

interface Props {
  tickers: Ticker[];
  current: string;
  onSelect: (name: string) => void;
}

type Tab = 'all' | 'up' | 'down';

export default function ContractRail({ tickers, current, onSelect }: Props) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('all');

  const rows = useMemo(() => {
    const needle = q.trim().toUpperCase();
    let list = tickers;
    if (needle) list = list.filter((t) => t.contract.includes(needle));
    if (tab === 'up') list = list.filter((t) => t.change24h > 0).sort((a, b) => b.change24h - a.change24h);
    if (tab === 'down') list = list.filter((t) => t.change24h < 0).sort((a, b) => a.change24h - b.change24h);
    return list.slice(0, 120);
  }, [tickers, q, tab]);

  return (
    <aside className="rail">
      <div className="rail-head">
        <input
          className="search"
          placeholder="搜索合约 · BTC / ETH…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
        <div className="rail-tabs">
          <button className={`rail-tab ${tab === 'all' ? 'on' : ''}`} onClick={() => setTab('all')}>全部</button>
          <button className={`rail-tab ${tab === 'up' ? 'on' : ''}`} onClick={() => setTab('up')}>涨</button>
          <button className={`rail-tab ${tab === 'down' ? 'on' : ''}`} onClick={() => setTab('down')}>跌</button>
        </div>
      </div>
      <div className="sym-list">
        {rows.length === 0 && <div className="empty">没有匹配的合约</div>}
        {rows.map((t) => (
          <button
            key={t.contract}
            className={`sym ${t.contract === current ? 'on' : ''}`}
            onClick={() => onSelect(t.contract)}
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
