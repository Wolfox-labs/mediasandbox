import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite 配置。
 *
 * 开发时把 `/api` 与 `/ws` 代理到后端（默认 8787），这样前端同源调用，
 * 不需要处理 CORS，也不需要在代码里写死后端地址。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env['MEDIASANDBOX_API'] ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env['MEDIASANDBOX_API'] ?? 'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
