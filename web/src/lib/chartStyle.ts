import { useSyncExternalStore } from 'react';

export type CandleStyle = 'filled' | 'hollow' | 'up-hollow' | 'down-hollow' | 'american';

export const CANDLE_STYLES: { id: CandleStyle; label: string }[] = [
  { id: 'filled', label: '全实心' },
  { id: 'hollow', label: '全空心' },
  { id: 'up-hollow', label: '上涨空心' },
  { id: 'down-hollow', label: '下跌空心' },
  { id: 'american', label: '美国线' },
];

const KEY = 'xf-rine:chart:candle-style';
const VALID = new Set<CandleStyle>(CANDLE_STYLES.map((style) => style.id));
const listeners = new Set<() => void>();

function readStored(): CandleStyle {
  try {
    const saved = localStorage.getItem(KEY) as CandleStyle | null;
    return saved && VALID.has(saved) ? saved : 'filled';
  } catch {
    return 'filled';
  }
}

let current: CandleStyle = readStored();

export function getCandleStyle(): CandleStyle {
  return current;
}

export function setCandleStyle(style: CandleStyle): void {
  if (!VALID.has(style) || style === current) return;
  current = style;
  try { localStorage.setItem(KEY, style); } catch { /* 偏好存不了也照样切 */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCandleStyle(): CandleStyle {
  return useSyncExternalStore(subscribe, getCandleStyle, getCandleStyle);
}
