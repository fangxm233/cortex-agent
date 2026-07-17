import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Standalone config (NOT mergeConfig — that concatenates include arrays and would
// drag in the unit suite). Integration tests fork real server subprocesses
// (app.ts) and need a far longer timeout than the 15s unit budget; run serially.
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
    pool: 'forks',
    isolate: true,
    poolOptions: { forks: { singleFork: true } },
    include: ['tests/**/integration-*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 120000,
    hookTimeout: 120000,
    teardownTimeout: 30000,
    reporters: ['dot'],
  },
});
