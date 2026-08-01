// input:  ESM requests from compiled thread runtime modules
// output: thread agent-facade imports redirected to a fake module
// pos:    Narrow module seam for the no-model baseline probe
// >>> If I am updated, update my header and folder CORTEX.md <<<

const FAKE_AGENT = new URL('./fake-run-agent-module.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const runnerParent = context.parentURL?.endsWith('/dist/domain/threads/runner.js')
    || context.parentURL?.endsWith('/src/domain/threads/runner.ts')
    || context.parentURL?.endsWith('/dist/domain/threads/local-runtime-deps.js')
    || context.parentURL?.endsWith('/src/domain/threads/local-runtime-deps.ts');
  const runnerImport = runnerParent && specifier === '../agents/index.js';
  if (runnerImport) return { url: FAKE_AGENT, shortCircuit: true };
  return nextResolve(specifier, context);
}
