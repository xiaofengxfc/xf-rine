import { useMemo, useState } from 'react';
import { fmtPct, fmtPrice } from '../lib/format.ts';
import type { ResearchScan } from '../lib/api.ts';

interface Props {
  scan: ResearchScan | null;
  loading: boolean;
  priceRoundOf: (symbol: string) => number;
  onPick: (symbol: string) => void;
}

/** 批量扫描表：按有效概率（触及 × 守住）降序，引擎已经排好，这里只做筛选和分页 */
export default function ScanTable({ scan, loading, priceRoundOf, onPick }: Props) {
  const [q, setQ] = useState('');
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);

  const rows = scan?.rows ?? [];
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return rows;
    return rows.filter((r) => (r.symbol + ' ' + r.trend_label + ' ' + (r.bucket ?? '')).toLowerCase().includes(k));
  }, [rows, q]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const cur = Math.min(page, pages);
  const slice = filtered.slice((cur - 1) * pageSize, cur * pageSize);

  const pct = (v: number | null) => (v === null ? '—' : Math.round(v * 100) + '%');
  const num = (v: number | null, sym: string) => (v === null ? '—' : fmtPrice(v, priceRoundOf(sym)));

  return (
    <div className="rsh-table-card">
      <div className="rsh-toolbar">
        <input
          className="rsh-search"
          placeholder="筛选品种 / 趋势 / 档位…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
        />
        <span className="dim" style={{ fontSize: 11 }}>
          {scan
            ? `${scan.summary.analyzed} 个分析成功 · ${scan.summary.failed} 个失败 · ${scan.summary.tf_label}`
            : (loading ? '正在扫描…' : '还没扫描')}
        </span>
        <div className="spacer" style={{ flex: 1 }} />
        <label className="dim" style={{ fontSize: 11 }}>
          每页
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </label>
        <div className="rsh-pager">
          <button type="button" onClick={() => setPage(Math.max(1, cur - 1))} disabled={cur <= 1}>‹</button>
          <span>{cur} / {pages}</span>
          <button type="button" onClick={() => setPage(Math.min(pages, cur + 1))} disabled={cur >= pages}>›</button>
        </div>
      </div>

      <div className="rsh-table-scroll">
        <table className="rsh-table">
          <thead>
            <tr>
              <th>#</th>
              <th>品种</th>
              <th>现价</th>
              <th>涨跌%</th>
              <th title="未来若干根内价格走到这个位的概率">触及概率</th>
              <th title="走到后反弹而不是跌穿的概率">守住概率</th>
              <th title="触及 × 守住，这张表按它排序">有效概率</th>
              <th>被测试</th>
              <th>档位</th>
              <th>趋势</th>
              <th>距离</th>
              <th>最近支撑</th>
              <th>最近压力</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={r.symbol} onClick={() => onPick(r.symbol)} title="点这一行看单品种深度分析">
                <td className="dim">{(cur - 1) * pageSize + i + 1}</td>
                <td className="sym">{r.symbol}{!r.adjusted && r.adjust_source && r.adjust_source !== 'none' ? ' *' : ''}</td>
                <td className="num">{num(r.current_price, r.symbol)}</td>
                <td className={`num ${r.change_pct >= 0 ? 'up' : 'down'}`}>{fmtPct(r.change_pct, 2)}</td>
                <td className="num">{pct(r.p_touch)}</td>
                <td className="num">{pct(r.p_hold)}</td>
                <td className="num strong">{pct(r.p_effective)}</td>
                <td className="num">{r.n_events ?? '—'}</td>
                <td className="num">{r.bucket ?? '—'}</td>
                <td>{r.trend_label}</td>
                <td className="num">{r.nearest_distance_pct === null ? '—' : fmtPct(r.nearest_distance_pct, 2)}</td>
                <td className="num s">{num(r.nearest_support, r.symbol)}</td>
                <td className="num r">{num(r.nearest_resistance, r.symbol)}</td>
              </tr>
            ))}
            {slice.length === 0 && (
              <tr><td colSpan={13} className="dim" style={{ textAlign: 'center', padding: 18 }}>
                {loading ? '正在扫描目录里的全部品种…' : (rows.length === 0 ? '还没有结果，先点「分析全部」' : '没有匹配的行')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {scan && scan.errors.length > 0 && (
        <div className="rsh-errors">
          跳过的品种：{scan.errors.slice(0, 8).map((e) => e.symbol + '（' + e.reason + '）').join('；')}
          {scan.errors.length > 8 ? `…共 ${scan.errors.length} 个` : ''}
        </div>
      )}
    </div>
  );
}
