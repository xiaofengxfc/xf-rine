import { useSyncExternalStore } from 'react';

/**
 * 主题只有两套：深色（原来的样子）和浅色。
 *
 * 存在 localStorage 里，刷新、重启 App 都跟着走。选择写在 `<html data-theme>` 上，
 * 样式表靠它切变量；图表是 canvas，拿不到 CSS 变量，所以另外给一份色板（chartColors）。
 */
export type Theme = 'dark' | 'light';

const KEY = 'xf-rine:theme';

function readStored(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    // 隐私模式下 localStorage 会抛，退回深色就是了
    return 'dark';
  }
}

let current: Theme = readStored();
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return current;
}

/**
 * 状态栏和手势条的图标颜色，跟着页面走。
 *
 * 壳的默认值看的是**系统**的深色/浅色，而页面主题是用户自己选的，两者不一定一致：
 * 系统深色 + 页面浅色时，默认值会让状态栏图标变成浅色贴在白底上，等于看不见。
 *
 * 这里不 import 插件包（浏览器和电脑端没有它），直接从壳上拿。
 * 拿不到就什么也不做 —— 图标颜色不对总比页面崩了强。
 */
export function syncSystemBars(): void {
  try {
    const cap = (globalThis as {
      Capacitor?: {
        Plugins?: Record<string, unknown>;
        registerPlugin?: (name: string) => unknown;
      };
    }).Capacitor;
    if (!cap) return;
    const plugin = (cap.Plugins?.SystemBars ?? cap.registerPlugin?.('SystemBars')) as
      | { setStyle?: (options: { style: string }) => Promise<void> }
      | undefined;
    // LIGHT = 浅色底（用深色图标），DARK = 深色底（用浅色图标）
    void plugin?.setStyle?.({ style: current === 'light' ? 'LIGHT' : 'DARK' });
  } catch {
    /* 插件没装进来、或者页面在普通浏览器里：不影响用 */
  }
}

/** 把选择写到 `<html>` 上，顺带换掉浏览器地址栏那一条的颜色 */
export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = current;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', current === 'light' ? '#f4f6f9' : '#0c0e12');
  syncSystemBars();
}

export function setTheme(next: Theme): void {
  if (next === current) return;
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* 存不了也照样切 */ }
  applyTheme();
  for (const fn of listeners) fn();
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 组件里读当前主题。切主题会让用到它的组件重渲染 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}

/**
 * 图表（lightweight-charts）用的那份色板。
 * canvas 里读不到 CSS 变量，只能在这里再写一遍 —— 改配色时两处要一起改。
 *
 * 分成三类，别混用：
 *   - 画布的面：底色、网格、坐标轴、十字线。跟 --bg / --line / --text 走。
 *   - K 线本身：涨、跌两色。跟 --up / --down 走（浅色下用深一档的那套，
 *     白底上的 #2ed3a0 太浅，一排实体看着像褪色）。
 *   - 图上叠加的东西：成交量、平价占位线、关键位、持仓/止损止盈/挂单。
 *     这一类要**弱于 K 线**：它们只是标注，抢了实体的颜色，图就先乱了。
 */
export interface ChartColors {
  background: string;
  /** 坐标轴和十字线上的字 */
  text: string;
  /** 横向网格：比竖线略实一点，读价格靠它 */
  gridHorz: string;
  /** 竖向网格：只用来定时间，压到几乎看不见 */
  gridVert: string;
  crosshair: string;
  crosshairLabel: string;
  border: string;
  /** 最后一价那条线（和它的轴标签） */
  priceLine: string;
  /** 折线模式那条收盘价线的颜色 */
  line: string;
  /** 涨跌两色：K 线实体与影线共用，成交量是它们的淡化版 */
  up: string;
  down: string;
  /**
   * 下面两项是**画在数据上**的颜色（每根 K 线各自带一份），不是 series 的选项。
   * 深色下用淡一点就够；浅色下同一个淡色落在白底上几乎看不见，
   * 成交量会整排消失 —— 所以浅色这边要更实一些。
   */
  volumeUp: string;
  volumeDown: string;
  /** 平价 K 线（最高 = 最低，交易所给的无成交占位线）画的中性灰 */
  flat: string;
  /** 关键位：支撑 / 阻力。比涨跌色淡，它们是横线不是行情 */
  zoneSupport: string;
  zoneResistance: string;
  /** 持仓均价 */
  entry: string;
  /** 强平价 */
  liq: string;
  /** 止损 / 止盈 */
  stop: string;
  target: string;
  /** 挂着没成交的限价单 */
  pending: string;
  /**
   * 形态标记：看涨用绿色、看跌用红色，画在 K 线下方。
   *
   * 以前这里是中性紫点 —— 理由写在 patterns.ts 文件头：7 万根实测里没有一个形态在 BH 校正后有
   * 正向方向增量。改成带方向的箭头是按产品要求来的，那个理由仍然有效，所以箭头只是把
   * 「教科书怎么说」画出来，实测胜率和基准照样跟在读数卡片、列表里，不把它当信号。
   * 这两色刻意和 K 线实体用同一个 up/down：同一个「涨」在整页里只该有一种绿。
   */
  patternBull: string;
  patternBear: string;
  /**
   * 手指按在图上时的十字线。
   *
   * 桌面那条 0.36 的灰线在 400px 宽的屏上几乎看不出来，而手机上没有光标可用，
   * 这条线是「现在读的是哪一根」的唯一提示 —— 按下去那会儿要看得清，抬手再淡回去。
   */
  crosshairTouch: string;
}

const CHART: Record<Theme, ChartColors> = {
  dark: {
    background: '#0c0e12',
    text: '#8b95a7',
    gridHorz: 'rgba(38,45,58,0.55)',
    gridVert: 'rgba(30,35,44,0.4)',
    crosshair: 'rgba(148,160,178,0.36)',
    crosshairLabel: '#242a35',
    border: '#1a1f28',
    priceLine: '#4c8dff',
    line: '#93a3b8',
    up: '#2ed3a0',
    down: '#ff5f6d',
    volumeUp: 'rgba(46,211,160,0.3)',
    volumeDown: 'rgba(255,95,109,0.26)',
    flat: 'rgba(126,138,152,0.45)',
    zoneSupport: 'rgba(46,211,160,0.72)',
    zoneResistance: 'rgba(255,95,109,0.72)',
    entry: '#ffcf4d',
    liq: '#ff8a4c',
    stop: 'rgba(255,95,109,0.82)',
    target: 'rgba(46,211,160,0.82)',
    pending: '#a885ff',
    patternBull: 'rgba(46,211,160,0.9)',
    patternBear: 'rgba(255,95,109,0.9)',
    crosshairTouch: 'rgba(186,198,216,0.9)',
  },
  light: {
    background: '#ffffff',
    text: '#5f6b7d',
    gridHorz: 'rgba(205,213,226,0.72)',
    gridVert: 'rgba(220,227,237,0.62)',
    crosshair: 'rgba(71,82,102,0.4)',
    crosshairLabel: '#dde3ec',
    border: '#e2e8f1',
    priceLine: '#2563eb',
    line: '#6b7689',
    up: '#0e8f62',
    down: '#d92d4b',
    volumeUp: 'rgba(14,143,98,0.34)',
    volumeDown: 'rgba(217,45,75,0.28)',
    flat: 'rgba(122,133,150,0.5)',
    zoneSupport: 'rgba(14,143,98,0.75)',
    zoneResistance: 'rgba(217,45,75,0.72)',
    entry: '#b45309',
    liq: '#c2410c',
    stop: 'rgba(217,45,75,0.85)',
    target: 'rgba(14,143,98,0.85)',
    pending: '#7c3aed',
    patternBull: 'rgba(14,143,98,0.9)',
    patternBear: 'rgba(217,45,75,0.9)',
    crosshairTouch: 'rgba(43,53,70,0.88)',
  },
};

export function chartColors(theme: Theme = current): ChartColors {
  return CHART[theme];
}
