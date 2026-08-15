// Safari(WebKit) 的 ReadableStream 缺 Symbol.asyncIterator，pdfjs-dist 6.x 内部用
// for await 迭代 ReadableStream（getTextContent）会报
// "undefined is not a function (near '...value of readableStream...')"。
// 注：ES module import 先于本模块体执行，故 polyfill 晚于 pdfjs 模块加载；
// 但 pdfjs 的迭代发生在用户触发解析时（远晚于此），因此仍正确生效。
// 仅当浏览器无原生实现时才注入（Chrome/Edge/Firefox 走原生，零影响）。
if (
  typeof ReadableStream !== 'undefined' &&
  !(ReadableStream.prototype as any)[Symbol.asyncIterator]
) {
  (ReadableStream.prototype as any)[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

import React, { Component, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('React 渲染异常:', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'sans-serif', textAlign: 'center' }}>
          <h2>页面渲染出错</h2>
          <p style={{ color: '#dc2626' }}>{this.state.error.message}</p>
          <p>当前画布状态可能已丢失。请刷新页面重试，或先在控制台查看报错。</p>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 24px', cursor: 'pointer' }}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
