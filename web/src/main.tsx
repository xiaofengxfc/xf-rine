import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import ConnectGate from './components/ConnectGate.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import { installBackHandler } from './lib/native.ts';
import { applyTheme } from './lib/theme.ts';
import './styles.css';

// 主题先贴上去：错了也得是用户上次选的那一套
applyTheme();

/**
 * 切页时别让浏览器「恢复滚动位置」。
 *
 * 手机上整页是 body 滚动的：从日内台（已经滚到 K 线下面）切到研究台，
 * 浏览器会把同样的滚动位置套到新页面上 —— 顶栏被顶到屏幕外，上面空出一大块，
 * 页签也只剩一半。切页这件事本身就是「从头看这一页」，自己滚回顶部更符合预期。
 */
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// 安卓返回键：先关浮层，没人接手才退出
void installBackHandler();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ConnectGate>
        <App />
      </ConnectGate>
    </ErrorBoundary>
  </StrictMode>,
);
