import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// The codebase uses NodeNext ESM: imports carry a `.js` extension but point at
// `.ts` sources (e.g. `../src/foo.js` → `src/foo.ts`). tsx resolves this at
// runtime; Vite does not. This pre-resolver strips a trailing `.js` and lets
// Vite's extension inference find the `.ts`/`.tsx` source. It also covers the
// `@core/*` … tsconfig path aliases (which likewise carry `.js`).
const jsToTsResolver = {
  name: 'cortex-js-to-ts',
  enforce: 'pre' as const,
  async resolveId(source: string, importer: string | undefined, options: any) {
    if (!source.endsWith('.js')) return null;
    const bare = source.slice(0, -3);
    const resolved = await (this as any).resolve(bare, importer, { ...options, skipSelf: true });
    return resolved ? resolved.id : null;
  },
};

export default defineConfig({
  plugins: [jsToTsResolver, tsconfigPaths()],
  esbuild: {
    // React 18 automatic JSX runtime for the ink/tui .tsx tests.
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    globals: false,
    environment: 'node',
    // node:test does not intercept console; several tests capture stdout/stderr by
    // patching process.*.write and assert on console.error output. Let console pass
    // straight through so those captures see it.
    disableConsoleIntercept: true,
    // Per-file CORTEX_HOME isolation — replaces `--import ./tests/_test-home.ts`.
    setupFiles: ['./tests/_vitest-setup.ts'],
    // Process-per-file model (mirrors node:test) — safest for the singleton
    // stores, native modules, and subprocess-spawning tests. The transpile is
    // still done ONCE by the shared Vite server and cached, so we keep the win.
    pool: 'forks',
    isolate: true,
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks: Number(process.env.CORTEX_TEST_CONCURRENCY ?? 16),
        minForks: 1,
      },
    },
    // node:test auto-restores `mock.method` spies after each test; mirror that.
    restoreMocks: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    teardownTimeout: 15000,
    // Match the run-tests.sh glob (unit tests only; integration handled separately).
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
    ],
    exclude: [
      'tests/**/_shims-*',
      'tests/**/_combined*',
      'tests/**/_plan*',
      'tests/**/integration-*.test.ts',
      'node_modules/**',
    ],
    reporters: process.env.CI ? ['default'] : ['dot'],
  },
});
