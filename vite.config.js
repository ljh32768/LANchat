import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Vite 插件：去掉构建产物 HTML 上 Vite 自动添加的 `crossorigin` 属性。
// 在 Electron 通过 file:// 加载打包后的 renderer 时，crossorigin 会触发 CORS 预检，
// 而 file:// 协议无法满足预检条件，导致脚本被拦截、页面空白。
function stripCrossorigin() {
  return {
    name: 'strip-crossorigin',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(/ crossorigin(=|>|[\s>])/g, ' $1');
      }
    }
  };
}

// Renderer is built into dist/ and loaded by Electron (file:// in prod, dev server in dev).
export default defineConfig({
  plugins: [react(), stripCrossorigin()],
  root: 'pages/src/renderer',
  base: './',
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'pages/src/renderer'),
      '@shared': path.resolve(__dirname, 'pages/src/shared')
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // 关闭 module preload 注入的 polyfill：减少内联脚本，
    // 避免被严格 CSP 误伤。
    modulePreload: { polyfill: false },
    // 显式关闭 sourcemap：file:// 加载 sourcemap 经常触发 CSP 警告
    sourcemap: false
  }
});
