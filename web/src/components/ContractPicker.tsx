import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { jget } from '../lib/api.ts';
import type { Ticker } from '../lib/api.ts';

interface Props {
  value: string;
  onChange: (contract: string) => void;
  disabled?: boolean;
  /** 只列当前环境能交易的合约（模拟盘只上架了几十个） */
  tradableOnly?: boolean;
  title?: string;
}

/** 一次最多渲染多少条。上千个合约全画出来会卡，也没人往下翻三百行 */
const MAX_ROWS = 60;

/**
 * 合约选择器：带搜索的下拉。
 *
 * 为什么不用原生 select：合约上千个，原生 select 只支持按首字母跳转，
 * 想找 ETH 之外某个小众合约只能一路滚。原生 datalist 也不行 ——
 * 它只在输入框空着、或当前文字正好是某个选项前缀时才弹，选过一次之后就用不上了。
 *
 * 列表来自 /api/tickers（Gate 的合约表），和交易台左栏同一份。
 */
export default function ContractPicker({ value, onChange, disabled, tradableOnly, title }: Props) {
  const [list, setList] = useState<Ticker[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * 拉合约表；拿不到（冷启动时服务端还没拉到整张表）就 3 秒后再试。
   *
   * 不重试的话，页面会停在「正在读取合约表…」上再也不动，看着像坏了。
   */
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      jget<Ticker[]>('/api/tickers')
        .then((rows) => {
          if (!alive) return;
          if (rows.length > 0) { setList(rows); setErr(''); return; }
          timer = setTimeout(load, 3000);
        })
        .catch((e) => {
          if (!alive) return;
          setErr((e as Error).message);
          timer = setTimeout(load, 3000);
        });
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  /** 成交额高的排前面：主流合约在最上面，找冷门的靠搜索 */
  const options = useMemo(() => {
    const rows = (list ?? []).filter((t) => (tradableOnly ? t.tradable !== false : true));
    return [...rows].sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  }, [list, tradableOnly]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return options.slice(0, MAX_ROWS);
    // 以它开头的排前面：搜 ETH 时 ETH_USDT 要在 WETH_USDT 前面
    const starts = options.filter((t) => t.contract.startsWith(q));
    const contains = options.filter((t) => !t.contract.startsWith(q) && t.contract.includes(q));
    return [...starts, ...contains].slice(0, MAX_ROWS);
  }, [options, query]);

  // 点外面收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) { setOpen(false); setQuery(''); }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 键盘移动时把当前项滚进视野
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  const pick = (c: string) => {
    onChange(c);
    setOpen(false);
    setQuery('');
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); setCursor(0); return; }
      setCursor((c) => Math.min(Math.max(0, filtered.length - 1), c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = filtered[cursor] ?? filtered[0];
      if (hit) pick(hit.contract);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  };

  const shown = open ? query : value;
  const hint = list === null ? (err ? '合约表读取失败，重试中…' : '正在读取合约表…') : '';

  return (
    <div className={'kpick' + (disabled ? ' disabled' : '')} ref={boxRef} title={title}>
      <input
        className="input kpick-input"
        value={shown}
        disabled={disabled}
        placeholder={hint || '搜索或选择合约'}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setCursor(0); }}
        onFocus={() => { if (!disabled) { setOpen(true); setQuery(''); setCursor(0); } }}
        onKeyDown={onKey}
      />
      <i className="kpick-caret">▾</i>
      {open && (
        <div className="kpick-list" ref={listRef}>
          {filtered.length === 0 && <div className="kpick-empty">{list === null ? hint : '没有匹配的合约'}</div>}
          {filtered.map((t, i) => (
            <button
              key={t.contract}
              type="button"
              className={'kpick-item' + (i === cursor ? ' on' : '') + (t.contract === value ? ' cur' : '')}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(t.contract)}
            >
              <b>{t.contract}</b>
              {t.tradable === false && <span className="kpick-tag">不可交易</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
