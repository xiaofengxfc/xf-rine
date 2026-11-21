import { fmtPct, fmtPrice } from '../lib/format.ts';
import type { Ticker } from '../lib/api.ts';
import { toggleTheme, useTheme } from '../lib/theme.ts';
import type { View } from '../lib/navigation.ts';

/** 页面切换：日内看盘、研究分析、AI 交易和策略。 */
interface Props {
  ticker: Ticker | undefined;
  env: 'testnet' | 'live';
  /** 现在连的是哪家交易所。写在品牌旁边，省得在 Bitget 上下单还以为在 Gate */
  exchange: string;
  /** 当前页面 */
  view: View;
  onView: (v: View) => void;
  /** AI 交易开着没有。开着的时候页签上带一个绿点，切走了也看得见 */
  aiOn: boolean;
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
  railCollapsed: boolean;
  onToggleRail: () => void;
}

export default function TopBar({
  ticker, env, exchange, view, onView, aiOn, priceRound, interval, wsAlive, armed, liveTrading, keysConfigured,
  onToggleArm, onOpenSettings, onOpenRail, railCollapsed, onToggleRail,
}: Props) {
  const chg = ticker?.change24h ?? 0;
  const theme = useTheme();
  return (
    <header className="topbar">
      <button className="icon-btn rail-btn" title="选合约（左栏）" aria-label="选合约" onClick={onOpenRail}>☰</button>
      <button
        className="icon-btn rail-collapse-btn"
        title={railCollapsed ? '展开币种列表' : '收起币种列表'}
        aria-label={railCollapsed ? '展开币种列表' : '收起币种列表'}
        aria-expanded={!railCollapsed}
        onClick={onToggleRail}
      >
        {railCollapsed ? '›' : '‹'}
      </button>

      <div className="brand">
        <b>巡风</b>
        <span className="wide-only">{exchange} 永续</span>
        <em className={`env-badge ${env}`}>{env === 'testnet' ? '模拟盘' : '实盘'}</em>
      </div>

      {/* 三个页面的切换。研究台不碰交易所，所以它在这里只有名字，没有环境徽标 */}
      <div className="view-switch">
        <button className={view === 'desk' ? 'on' : ''} onClick={() => onView('desk')}>日内台</button>
        <button className={view === 'research' ? 'on' : ''} onClick={() => onView('research')}>研究台</button>
        <button className={view === 'ai' ? 'on' : ''} onClick={() => onView('ai')}>
          AI 交易
          {/* 开着的时候点一个绿点：切到别的页面也别忘了它正在自己下单 */}
          <i className={`tab-dot${aiOn ? ' live' : ' dormant'}`} aria-hidden="true" />
        </button>
        {/*
          「策略」而不是「回测研究台」：这一页最常做的事是编策略和回测，
          四个字的名字在窄屏上会被挤掉，而且"回测研究台"听起来是看报告的地方，
          不是一个能编辑东西的入口。
        */}
        <button className={view === 'quant' ? 'on' : ''} onClick={() => onView('quant')}>策略</button>
      </div>

      <div className="ticker-head">
        <span className="sym">{ticker?.contract.replace('_USDT', '') ?? '—'}</span>
        <span className="dim wide-only" style={{ fontSize: 11 }}>USDT 永续</span>
        {/* 还没有第一帧行情时写「—」：拿 0 去格式化会印出一个像模像样的 0.0 */}
        <span className={`px num ${ticker ? (chg >= 0 ? 'up' : 'down') : ''}`}>
          {ticker ? fmtPrice(ticker.last, priceRound) : '—'}
        </span>
        <span className={`chg num ${ticker ? (chg >= 0 ? 'up' : 'down') : ''}`}>
          {ticker ? fmtPct(chg) : '—'}
        </span>
      </div>

      <span className="pill wide-only market-mark-pill">标记 {ticker ? fmtPrice(ticker.mark, priceRound) : '—'}</span>
      <span className="pill wide-only market-funding-pill">资金费 {ticker ? fmtPct(ticker.fundingRate * 100, 4) : '—'}</span>
      <span className="pill wide-only market-interval-pill">周期 {interval}</span>
      <span className="pill wide-only market-volume-pill">24h {ticker ? (ticker.volume24hUsd / 1e6).toFixed(1) + 'M' : '—'}</span>

      <div className="spacer" />

      <span className="pill wide-only ws-pill market-status-pill">
        <i className={`status-dot ${wsAlive ? 'live' : 'off'}`} />
        {wsAlive ? '行情已连接' : '行情断开'}
      </span>
      {/* 窄屏放不下那句话，只留一个点，鼠标悬停能看全 */}
      <i className={`status-dot ws-dot ${wsAlive ? 'live' : 'off'}`} title={wsAlive ? '行情已连接' : '行情断开'} />

      <button className={`arm-btn ${armed ? 'on' : ''}`} onClick={onToggleArm} title="解锁后一直可以下单，直到你锁定、切换环境或关掉下单开关">
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

      {!keysConfigured && <span className="pill market-warning-pill" style={{ color: 'var(--warn)', borderColor: 'rgba(240,180,41,0.4)' }}>未配置密钥</span>}
      {keysConfigured && !liveTrading && <span className="pill wide-only market-readonly-pill">只读模式</span>}
    </header>
  );
}
