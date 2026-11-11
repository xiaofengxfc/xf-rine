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
