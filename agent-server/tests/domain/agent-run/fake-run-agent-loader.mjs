// input:  ESM resolve requests from the compiled thread runner
// output: runner agent-facade import redirected to a fake module
// pos:    Narrow module seam for the no-model baseline probe
// >>> If I am updated, update my header and folder CORTEX.md <<<

const FAKE_AGENT = new URL('./fake-run-agent-module.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const runnerImport = context.parentURL?.endsWith('/dist/domain/threads/runner.js')
    && specifier === '../agents/index.js';
  if (runnerImport) return { url: FAKE_AGENT, shortCircuit: true };
  return nextResolve(specifier, context);
}
