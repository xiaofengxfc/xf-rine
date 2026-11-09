import { fmtPct, fmtPrice } from '../lib/format.ts';
import type { Ticker } from '../lib/api.ts';

interface Props {
  ticker: Ticker | undefined;
  env: 'testnet' | 'live';
  priceRound: number;
  interval: string;
  wsAlive: boolean;
  armed: boolean;
  liveTrading: boolean;
  keysConfigured: boolean;
  onToggleArm: () => void;
  onOpenSettings: () => void;
}

export default function TopBar({
  ticker, env, priceRound, interval, wsAlive, armed, liveTrading, keysConfigured, onToggleArm, onOpenSettings,
}: Props) {
  const chg = ticker?.change24h ?? 0;
  return (
    <header className="topbar">
      <div className="brand">
        <b>巡风</b>
        <span>Gate 永续</span>
        <em className={`env-badge ${env}`}>{env === 'testnet' ? '模拟盘' : '实盘'}</em>
      </div>

      <div className="ticker-head">
        <span className="sym">{ticker?.contract.replace('_USDT', '') ?? '—'}</span>
        <span className="dim" style={{ fontSize: 11 }}>USDT 永续</span>
        <span className={`px num ${chg >= 0 ? 'up' : 'down'}`}>
          {fmtPrice(ticker?.last ?? 0, priceRound)}
        </span>
        <span className={`chg num ${chg >= 0 ? 'up' : 'down'}`}>{fmtPct(chg)}</span>
      </div>

      <span className="pill">标记 {fmtPrice(ticker?.mark ?? 0, priceRound)}</span>
      <span className="pill">资金费 {fmtPct((ticker?.fundingRate ?? 0) * 100, 4)}</span>
      <span className="pill">周期 {interval}</span>
      <span className="pill">24h {ticker ? (ticker.volume24hUsd / 1e6).toFixed(1) + 'M' : '—'}</span>

      <div className="spacer" />

      <span className="pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <i className={`status-dot ${wsAlive ? 'live' : 'off'}`} />
        {wsAlive ? '行情已连接' : '行情断开'}
      </span>

      <button className={`arm-btn ${armed ? 'on' : ''}`} onClick={onToggleArm} title="解锁后 10 分钟内可以下单">
        <i className={`status-dot ${armed ? 'off' : ''}`} />
        {armed ? '交易已解锁 · 点击锁定' : '解锁交易'}
      </button>

      <button className="icon-btn" title="设置" onClick={onOpenSettings}>⚙</button>

      {!keysConfigured && <span className="pill" style={{ color: 'var(--warn)', borderColor: 'rgba(240,180,41,0.4)' }}>未配置密钥</span>}
      {keysConfigured && !liveTrading && <span className="pill">只读模式</span>}
    </header>
  );
}
