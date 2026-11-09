import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null; info: string }

/**
 * 兜底错误边界。
 * React 19 遇到渲染期未捕获异常会把整棵树立卸掉，页面只剩背景色，看起来就是黑屏。
 * 这里把它接住，显示错误原文并提供重新加载，至少能看出出了什么事。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[uncaught]', error, info.componentStack);
    this.setState({ info: info.componentStack ?? '' });
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h1>界面崩了</h1>
        <p>详情已打印到浏览器控制台。点下面的按钮重新加载。</p>
        <pre>{error.message}</pre>
        {info && <pre className="stack">{info.trim().split('\n').slice(0, 8).join('\n')}</pre>}
        <button onClick={() => location.reload()}>重新加载</button>
      </div>
    );
  }
}
