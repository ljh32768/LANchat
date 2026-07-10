import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Renderer is built into dist/ and loaded by Electron (file:// in prod, dev server in dev).
export default defineConfig({
  plugins: [react()],
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
    emptyOutDir: true
  }
});
