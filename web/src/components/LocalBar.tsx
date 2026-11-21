import { useState } from 'react';
import type { LocalInstrument } from '../lib/api.ts';

interface Props {
  /** 记住的目录。空字符串 = 还没选过 */
  dir: string;
  instruments: LocalInstrument[];
  files: number;
  /** 认得的品种数（引擎报的，和 instruments.length 同源） */
  count: number;
  /** 目录在、但引擎读不出来的原因 */
  warning: string;
  /** 现在这张图算的是本地文件，还是交易所实时行情 */
  on: boolean;
  /** 当前服务端是否允许选择本机目录 */
  canPick: boolean;
  /** 现在看的品种 / 周期 */
  symbol: string;
  tf: string;
  onSymbol: (s: string) => void;
  onTf: (tf: string) => void;
  /** 把这张图切到本地数据 */
  onUse: () => void;
  onPickDir: (dir: string) => void;
  /** 关掉本地模式，回到交易所行情 */
  onExit: () => void;
}

/**
 * 本地数据条：选一个满是 Parquet/CSV 的目录，然后在这批历史文件上算档位。
 *
 * 摆成一条而不是塞进设置页，是因为它会改变「这张图上的数据是谁」——
 * 用户必须一眼看到现在看的是本地文件还是交易所实时行情，否则会拿三个月前的
 * 收盘价去对现在的盘口，还以为图坏了。
 *
 * 「记住过目录」和「正在用本地数据」是两件事，这里必须分开画：
 * 以前只要记住过目录就整条点亮，图却还是交易所的行情，条上写着 AGT_USDT/H1、
 * 图上画着 BTC —— 这种自相矛盾比不显示更糟。
 */
export default function LocalBar({
  dir, instruments, files, count, warning, on, canPick, symbol, tf, onSymbol, onTf, onUse, onPickDir, onExit,
}: Props) {
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  /** 当前品种有哪些周期 */
  const tfs = instruments.find((i) => i.symbol === symbol)?.timeframes ?? [];

  /** 选目录那一小块浮层：没目录、有目录但没启用、启用中三种状态都要用 */
  const picker = open && (
    <div className="lb-pick">
      <input
        className="input"
        placeholder="D:/data/futures   （文件名：EURUSD_H1.parquet）"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) onPickDir(input.trim()); }}
      />
      <button className="btn xs" disabled={!input.trim()} onClick={() => onPickDir(input.trim())}>
        {dir ? '切过去' : '用这个目录'}
      </button>
    </div>
  );

  if (!dir) {
    return (
      <div className="local-bar">
        <span className="lb-tag">本地数据</span>
        <span className="dim">没选目录。选一个放着「品种_周期.parquet」的文件夹，就能离线算支撑阻力。</span>
        <button className="btn ghost xs" onClick={() => setOpen((v) => !v)} disabled={!canPick}>
          {canPick ? (open ? '收起' : '选目录') : '只能在电脑上选'}
        </button>
        {picker}
      </div>
    );
  }

  return (
    <div className={`local-bar${on ? ' on' : ''}`}>
      <span className="lb-tag">{on ? '本地数据' : '本地目录'}</span>
      <span className="lb-dir mono" title={dir}>{dir}</span>
      <select
        className="lb-sel"
        value={symbol}
        onChange={(e) => onSymbol(e.target.value)}
        title="文件里出现的品种（选一个就用本地数据看图）"
      >
        {instruments.length === 0 && <option value="">（目录里没有认得的数据文件）</option>}
        {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
      </select>
      <select
        className="lb-sel"
        value={tf}
        onChange={(e) => onTf(e.target.value)}
        title="这个品种在目录里有哪几个周期"
      >
        {tfs.length === 0 && <option value={tf}>{tf}</option>}
        {tfs.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <span className="dim">{count > 0 ? `${count} 个品种 · ` : ''}{files} 个文件</span>
      {warning && <span className="lb-warn" title={warning}>目录读不出来</span>}
      <div style={{ flex: 1 }} />
      {on ? (
        <button className="btn ghost xs" onClick={onExit} title="回到交易所实时行情">
          回到行情
        </button>
      ) : (
        <button className="btn xs accent" onClick={onUse} disabled={instruments.length === 0}>
          用本地数据
        </button>
      )}
      <button className="btn ghost xs" onClick={() => setOpen((v) => !v)} disabled={!canPick}>
        换目录
      </button>
      {picker}
    </div>
  );
}
