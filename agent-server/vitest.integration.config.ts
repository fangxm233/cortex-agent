// input:  Vitest, tsconfig paths, integration test globs
// output: serial process-level integration test configuration
// pos:    Runs server and agent-run process tests in one fork
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Standalone config (NOT mergeConfig — that concatenates include arrays and would
// drag in the unit suite). Process-level tests run serially so their child trees do
// not compete with the unit suite's parallel worker pool.
const jsToTsResolver = {
  name: 'cortex-js-to-ts',
  enforce: 'pre' as const,
  async resolveId(source: string, importer: string | undefined, options: any) {
    if (!source.endsWith('.js')) return null;
    const resolved = await (this as any).resolve(source.slice(0, -3), importer, { ...options, skipSelf: true });
    return resolved ? resolved.id : null;
  },
};

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
      'tests/domain/agent-run/*-e2e.test.ts',
    ],
    exclude: ['node_modules/**'],
    testTimeout: 120000,
    hookTimeout: 120000,
    teardownTimeout: 30000,
    reporters: ['dot'],
  },
});
