/// <reference types="vitest/config" />
import path from 'node:path';
import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Build stamp inlined into the bundle via `define` below and shown in the mobile Settings footer.
// Recomputed each build (timestamp + git short sha), so every build has a distinct value AND a
// distinct content hash — which is what lets the desktop/Android frontend OTA detect a new version
// and lets you eyeball on-device that the OTA swap actually landed.
const BUILD_STAMP = (() => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const ts = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  let sha = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // not a git checkout — timestamp alone still distinguishes builds
  }
  return sha ? `${ts}·${sha}` : ts;
})();

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
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },
  // Cap test workers: vitest defaults to one worker per CPU core (72 on lab2),
  // which saturates the box and causes load-induced flakes. Mirror the
  // agent-server cap (CORTEX_TEST_CONCURRENCY, default 16).
  test: {
    maxWorkers: Number(process.env.CORTEX_TEST_CONCURRENCY ?? 16),
    minWorkers: 1,
  },
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
