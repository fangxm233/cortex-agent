import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { SHARED_POOL_FILES } from './tests/_shared-pool-manifest.js';
import { jsToTsResolver } from './tests/_vite-js-to-ts-resolver.js';

// Sharding (opt-in, used by scripts/run-tests.sh):
//   CORTEX_TEST_SHARD=shared    only the manifest files, isolate:false — one
//                               module registry per worker fork, so the import
//                               graph (the dominant suite cost) is executed
//                               once per fork instead of once per file.
//   CORTEX_TEST_SHARD=isolated  everything except the manifest files, with
//                               full per-file isolation (previous behavior).
//   unset                       all files, full isolation — scoped dev runs
//                               (`vitest run <file>`) behave exactly as before.
const SHARD = process.env.CORTEX_TEST_SHARD;

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
    // Per-file CORTEX_HOME isolation.
    setupFiles: ['./tests/_vitest-setup.ts'],
    // Allocates the run-scoped temp-home root and removes it once every worker is done.
    // Required: fork workers are killed with SIGTERM/SIGKILL, so worker-side 'exit'
    // handlers never fire and the homes would leak into /tmp (see tests/_test-home-root.ts).
    globalSetup: ['./tests/_global-setup.ts'],
    // Process-per-file model (mirrors node:test) — safest for the singleton
    // stores, native modules, and subprocess-spawning tests. The transpile is
    // still done ONCE by the shared Vite server and cached, so we keep the win.
    // The `shared` shard relaxes this to worker-per-many-files for the vetted
    // pure-logic manifest (see tests/_shared-pool-manifest.ts).
    pool: 'forks',
    isolate: SHARD !== 'shared',
    poolOptions: {
      forks: {
        singleFork: false,
        // Shared shard: fewer forks → better module-cache reuse per fork.
        maxForks: SHARD === 'shared'
          ? Number(process.env.CORTEX_TEST_SHARED_CONCURRENCY ?? 4)
          : Number(process.env.CORTEX_TEST_CONCURRENCY ?? 16),
        minForks: 1,
      },
    },
    // node:test auto-restores `mock.method` spies after each test; mirror that.
    restoreMocks: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    teardownTimeout: 15000,
    // Match the run-tests.sh glob (unit tests only; integration handled separately).
    include: SHARD === 'shared'
      ? SHARED_POOL_FILES
      : [
          'tests/**/*.test.ts',
          'tests/**/*.test.tsx',
        ],
    exclude: [
      'tests/**/integration-*.test.ts',
      'node_modules/**',
      ...(SHARD === 'isolated' ? SHARED_POOL_FILES : []),
    ],
    reporters: process.env.CI ? ['default'] : ['dot'],
  },
});
