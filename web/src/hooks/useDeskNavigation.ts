import { useCallback, useEffect, useState } from 'react';
import type { View } from '../lib/navigation.ts';

const RAIL_COLLAPSED_KEY = 'xf-rine:rail-collapsed';

function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function readView(): View {
  const hash = window.location.hash;
  return hash === '#research' ? 'research'
    : hash === '#ai' ? 'ai'
      : hash === '#quant' ? 'quant'
        : 'desk';
}

interface Options {
  settingsOpen: boolean;
  closeSettings: () => void;
}

export function useDeskNavigation({ settingsOpen, closeSettings }: Options) {
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(readRailCollapsed);
  const [view, setViewState] = useState(readView);
  const [researchMounted, setResearchMounted] = useState(view === 'research');
  const [aiMounted, setAiMounted] = useState(view === 'ai');
  const [quantMounted, setQuantMounted] = useState(view === 'quant');

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_COLLAPSED_KEY, railCollapsed ? '1' : '0');
    } catch {
      // The collapsed state is a preference, not a prerequisite for the layout.
    }
  }, [railCollapsed]);

  const setView = useCallback((next: View) => {
    setViewState(next);
    /**
     * 换一页就回到顶部。
     *
     * 手机上 body 是整页滚动容器，切页时浏览器会沿用上一页的滚动位置：
     * 打开研究台先看到的是「半截顶栏 + 一大片空白」，页签贴在屏幕上方三分之一处。
     * 这一条和 main.tsx 里的 scrollRestoration 一起，保证换页从第一屏开始。
     */
    window.scrollTo({ top: 0, behavior: 'auto' });
    document.querySelectorAll<HTMLElement>('.research-main, .ai-main').forEach((el) => { el.scrollTop = 0; });
    if (next === 'research') setResearchMounted(true);
    if (next === 'ai') setAiMounted(true);
    if (next === 'quant') setQuantMounted(true);

    try {
      const hash = next === 'research' ? '#research'
        : next === 'ai' ? '#ai'
          : next === 'quant' ? '#quant'
            : window.location.pathname + window.location.search;
      window.history.replaceState(null, '', hash);
    } catch {
      // Some WebViews do not allow history changes. Navigation still works in place.
    }
  }, []);

  useEffect(() => {
    const onBack = (event: Event) => {
      if (settingsOpen) {
        event.preventDefault();
        closeSettings();
        return;
      }
      if (railOpen) {
        event.preventDefault();
        setRailOpen(false);
        return;
      }
      if (view !== 'desk') {
        event.preventDefault();
        setView('desk');
      }
    };
    window.addEventListener('xf-back', onBack);
    return () => window.removeEventListener('xf-back', onBack);
  }, [settingsOpen, closeSettings, railOpen, view, setView]);

  useEffect(() => {
    if (!railOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRailOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [railOpen]);

  useEffect(() => {
    if (!railOpen) return;
    const query = window.matchMedia('(max-width: 1180px)');
    const onChange = () => {
      if (!query.matches) setRailOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [railOpen]);

  return {
    view,
    setView,
    researchMounted,
    aiMounted,
    quantMounted,
    railOpen,
    setRailOpen,
    railCollapsed,
    setRailCollapsed,
  };
}
