import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server proxies the tRPC endpoint to the agent-server ui-http-server (port 3004,
// Stage-1 task 3). The proxy only engages on request, so `pnpm dev` boots even before
// 3004 exists. In production the SPA is served same-origin by agent-server, so the
// relative `/trpc` URL resolves without a proxy.
//
// The ui-http-server gates /trpc with an `x-cortex-token` bearer (== CORTEX_CLIENT_TOKEN).
// SSE EventSource cannot set custom headers and the browser must not hold the secret, so
// the dev proxy injects the token from the env for every proxied request (query, mutate,
// and the SSE subscription GET). Set CORTEX_CLIENT_TOKEN in the dev shell to reach live data.
const CLIENT_TOKEN = (process.env.CORTEX_CLIENT_TOKEN ?? '').trim();

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/trpc': {
        target: 'http://127.0.0.1:3004',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (CLIENT_TOKEN) proxyReq.setHeader('x-cortex-token', CLIENT_TOKEN);
          });
        },
      },
      '/api': {
        target: 'http://127.0.0.1:3004',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (CLIENT_TOKEN) proxyReq.setHeader('x-cortex-token', CLIENT_TOKEN);
          });
        },
      },
    },
  },
});
