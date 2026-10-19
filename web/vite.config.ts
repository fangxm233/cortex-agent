/// <reference types="vitest/config" />
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig, type HttpProxy, type Plugin } from 'vite';

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

// The server refuses a state-changing request whose Origin is neither its own nor allow-listed.
// `changeOrigin` rewrites Host to 127.0.0.1:3004 but leaves this page's Origin, so the dev page's
// own requests drop Origin and ride the injected token like any non-browser client. A request
// from any OTHER page keeps its foreign Origin and is refused — the proxy holds the token, so it
// must not lend it to whatever site the developer happens to have open.
const dropOwnOrigin = (proxyReq: { removeHeader: (name: string) => void }, req: { headers: Record<string, string | string[] | undefined> }): void => {
  const origin = req.headers.origin;
  try {
    if (typeof origin === 'string' && new URL(origin).host === req.headers.host) proxyReq.removeHeader('origin');
  } catch {
    // Unparseable Origin (e.g. `null`): leave it for the server to refuse.
  }
};

// WebSocket handshakes (the agent browser stream) get the same Origin treatment but NOT the token:
// the stream authenticates with a ticket the page fetched over the proxied HTTP routes.
const proxyAsDevPage = (proxy: HttpProxy.Server): void => {
  proxy.on('proxyReq', (proxyReq, req) => {
    if (CLIENT_TOKEN) proxyReq.setHeader('x-cortex-token', CLIENT_TOKEN);
    dropOwnOrigin(proxyReq, req);
  });
  proxy.on('proxyReqWs', (proxyReq, req) => dropOwnOrigin(proxyReq, req));
};

// `import uri from './x.woff2?data-uri'` → the file as a base64 `data:` URI string. The board
// frame has an opaque origin and cannot load the app's own files, so the KaTeX fonts it needs
// travel inside its document; importing them this way lands them in the lazy chunk that uses them.
const DATA_URI_MIME: Record<string, string> = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

const dataUriImports = (): Plugin => ({
  name: 'cortex:data-uri',
  enforce: 'pre',
  async load(id) {
    const [file, query] = id.split('?');
    if (query !== 'data-uri' || !file) return null;
    const mime = DATA_URI_MIME[path.extname(file)] ?? 'application/octet-stream';
    const base64 = (await readFile(file)).toString('base64');
    return `export default ${JSON.stringify(`data:${mime};base64,${base64}`)};`;
  },
});

export default defineConfig({
  plugins: [react(), dataUriImports()],
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },
  // Cap test workers: vitest defaults to one worker per CPU core (72 on a big box),
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
        configure: proxyAsDevPage,
      },
      '/api': {
        target: 'http://127.0.0.1:3004',
        changeOrigin: true,
        ws: true,
        configure: proxyAsDevPage,
      },
    },
  },
});
