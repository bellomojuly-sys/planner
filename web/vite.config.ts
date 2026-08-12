import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: { '@web': resolve(here, 'src') },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    // The service worker must keep its filename and live at the root scope,
    // so it is copied verbatim from public/ rather than bundled.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
    // `wrangler dev` serves the API; the front end proxies to it so cookies
    // are same-origin in development exactly as they are in production.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
