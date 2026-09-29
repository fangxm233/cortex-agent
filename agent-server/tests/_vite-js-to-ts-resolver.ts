// The codebase uses NodeNext ESM: imports carry a `.js` extension but point at
// `.ts` sources (e.g. `../src/foo.js` → `src/foo.ts`). tsx resolves this at
// runtime; Vite does not. This pre-resolver strips a trailing `.js` and lets
// Vite's extension inference find the `.ts`/`.tsx` source. It also covers the
// `@core/*` … tsconfig path aliases (which likewise carry `.js`).
// Shared by vitest.config.ts and vitest.integration.config.ts.
export const jsToTsResolver = {
  name: 'cortex-js-to-ts',
  enforce: 'pre' as const,
  async resolveId(source: string, importer: string | undefined, options: any) {
    if (!source.endsWith('.js')) return null;
    const bare = source.slice(0, -3);
    const resolved = await (this as any).resolve(bare, importer, { ...options, skipSelf: true });
    return resolved ? resolved.id : null;
  },
};
