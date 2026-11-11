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

/** 把选择写到 `<html>` 上，顺带换掉浏览器地址栏那一条的颜色 */
export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = current;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', current === 'light' ? '#f4f6f9' : '#0c0e12');
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
 */
export interface ChartColors {
  background: string;
  text: string;
  grid: string;
  crosshair: string;
  crosshairLabel: string;
  border: string;
  priceLine: string;
  /** 折线模式那条收盘价线的颜色 */
  line: string;
  /**
   * 下面三项是**画在数据上**的颜色（每根 K 线各自带一份），不是 series 的选项。
   * 深色下用淡一点就够；浅色下同一个淡色落在白底上几乎看不见，
   * 成交量会整排消失、平价 K 线会变成一片白 —— 所以浅色这边要更实一些。
   */
  volumeUp: string;
  volumeDown: string;
  /** 平价 K 线（最高 = 最低，交易所给的无成交占位线）画的中性灰 */
  flat: string;
}

const CHART: Record<Theme, ChartColors> = {
  dark: {
    background: '#0c0e12',
    text: '#98a2b3',
    grid: 'rgba(30,35,44,0.55)',
    crosshair: 'rgba(152,162,179,0.4)',
    crosshairLabel: '#1e232d',
    border: '#1e232c',
    priceLine: '#4c8dff',
    line: '#9aa7b8',
    volumeUp: 'rgba(46,211,160,0.28)',
    volumeDown: 'rgba(255,95,109,0.28)',
    flat: 'rgba(139,152,165,0.55)',
  },
  light: {
    background: '#ffffff',
    text: '#4d5870',
    grid: 'rgba(223,228,236,0.9)',
    crosshair: 'rgba(77,88,112,0.45)',
    crosshairLabel: '#dfe4ec',
    border: '#dfe4ec',
    priceLine: '#2563eb',
    line: '#6b7689',
    volumeUp: 'rgba(14,143,98,0.45)',
    volumeDown: 'rgba(217,45,75,0.42)',
    flat: 'rgba(107,118,137,0.7)',
  },
};

export function chartColors(theme: Theme = current): ChartColors {
  return CHART[theme];
}
