import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/theme.css';
import './styles/animations.css';
import './styles/layout.css';

// 错误边界：捕获渲染异常，避免透明窗口崩溃后完全不可见
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 32, color: '#5F6368', fontFamily: 'Consolas, monospace',
          fontSize: 13, lineHeight: 1.6, height: '100%', overflow: 'auto'
        }}>
          <div style={{ color: '#EA4335', fontSize: 16, marginBottom: 12 }}>⚠ 渲染异常</div>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <div style={{ marginTop: 16, color: '#9AA0A6' }}>
            请将以上错误信息反馈。可按 Ctrl+R 重新加载。
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
