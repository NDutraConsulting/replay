import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { cleanUrlsPlugin } from './build/clean-urls.js';

// The FastAPI backend (backend/, `./run.sh`). In development and preview, /api is proxied to it,
// so the browser sees one origin: the session cookie just works and no CORS is involved.
const backend = process.env.BACKEND_URL ?? 'http://localhost:8000';
const proxy = { '/api': { target: backend, changeOrigin: false } };

// Multi-page app: one HTML entry per page/feature.
export default defineConfig({
  plugins: [cleanUrlsPlugin()], // /account, not /account.html
  server: { proxy },
  preview: { proxy },
  build: {
    rollupOptions: {
      input: {
        chat: resolve(import.meta.dirname, 'index.html'),
        replay: resolve(import.meta.dirname, 'replay.html'),
        agents: resolve(import.meta.dirname, 'agents.html'),
        account: resolve(import.meta.dirname, 'account.html'),
        login: resolve(import.meta.dirname, 'login.html'),
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.js'],
  },
});
