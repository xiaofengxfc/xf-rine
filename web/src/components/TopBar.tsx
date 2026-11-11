import { fmtPct, fmtPrice } from '../lib/format.ts';
import type { Ticker } from '../lib/api.ts';
import { toggleTheme, useTheme } from '../lib/theme.ts';

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
  /** 窄屏时左栏收成抽屉，用这个按钮打开 */
  onOpenRail: () => void;
}

export default function TopBar({
  ticker, env, priceRound, interval, wsAlive, armed, liveTrading, keysConfigured, onToggleArm, onOpenSettings, onOpenRail,
}: Props) {
  const chg = ticker?.change24h ?? 0;
  const theme = useTheme();
  return (
    <header className="topbar">
      <button className="icon-btn rail-btn" title="选合约（左栏）" aria-label="选合约" onClick={onOpenRail}>☰</button>

      <div className="brand">
        <b>巡风</b>
        <span>Gate 永续</span>
        <em className={`env-badge ${env}`}>{env === 'testnet' ? '模拟盘' : '实盘'}</em>
      </div>

      <div className="ticker-head">
        <span className="sym">{ticker?.contract.replace('_USDT', '') ?? '—'}</span>
        <span className="dim wide-only" style={{ fontSize: 11 }}>USDT 永续</span>
        <span className={`px num ${chg >= 0 ? 'up' : 'down'}`}>
          {fmtPrice(ticker?.last ?? 0, priceRound)}
        </span>
        <span className={`chg num ${chg >= 0 ? 'up' : 'down'}`}>{fmtPct(chg)}</span>
      </div>

      <span className="pill wide-only">标记 {fmtPrice(ticker?.mark ?? 0, priceRound)}</span>
      <span className="pill wide-only">资金费 {fmtPct((ticker?.fundingRate ?? 0) * 100, 4)}</span>
      <span className="pill wide-only">周期 {interval}</span>
      <span className="pill wide-only">24h {ticker ? (ticker.volume24hUsd / 1e6).toFixed(1) + 'M' : '—'}</span>

      <div className="spacer" />

      <span className="pill wide-only ws-pill">
        <i className={`status-dot ${wsAlive ? 'live' : 'off'}`} />
        {wsAlive ? '行情已连接' : '行情断开'}
      </span>
      {/* 窄屏放不下那句话，只留一个点，鼠标悬停能看全 */}
      <i className={`status-dot ws-dot ${wsAlive ? 'live' : 'off'}`} title={wsAlive ? '行情已连接' : '行情断开'} />

      <button className={`arm-btn ${armed ? 'on' : ''}`} onClick={onToggleArm} title="解锁后 10 分钟内可以下单">
        <i className={`status-dot ${armed ? 'off' : ''}`} />
        {armed ? <><span className="wide-only">交易已解锁 · 点击</span>锁定</> : '解锁交易'}
      </button>

      {/* 主题开关放在这里：和设置挨着，随手就能切，不用翻进弹窗 */}
      <button
        className="icon-btn theme-btn"
        onClick={toggleTheme}
        title={theme === 'dark' ? '换成浅色模式' : '换成深色模式'}
        aria-label={theme === 'dark' ? '换成浅色模式' : '换成深色模式'}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>

      <button className="icon-btn" title="设置" onClick={onOpenSettings}>⚙</button>

      {!keysConfigured && <span className="pill" style={{ color: 'var(--warn)', borderColor: 'rgba(240,180,41,0.4)' }}>未配置密钥</span>}
      {keysConfigured && !liveTrading && <span className="pill wide-only">只读模式</span>}
    </header>
  );
}
