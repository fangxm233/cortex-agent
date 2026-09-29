import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { jsToTsResolver } from './tests/_vite-js-to-ts-resolver.js';

// Standalone config (NOT mergeConfig — that concatenates include arrays and would
// drag in the unit suite). Process-level tests run serially so their child trees do
// not compete with the unit suite's parallel worker pool.

export default defineConfig({
  plugins: [jsToTsResolver, tsconfigPaths()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    globals: false,
    environment: 'node',
    disableConsoleIntercept: true,
    setupFiles: ['./tests/_vitest-setup.ts'],
    globalSetup: ['./tests/_global-setup.ts'],
    pool: 'forks',
    isolate: true,
    poolOptions: { forks: { singleFork: true } },
    include: [
      'tests/**/integration-*.test.ts',
    ],
    exclude: ['node_modules/**'],
    testTimeout: 120000,
    hookTimeout: 120000,
    teardownTimeout: 30000,
    reporters: ['dot'],
  },
});
