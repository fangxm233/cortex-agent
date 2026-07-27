// input:  process-style environment map (defaults to process.env)
// output: isDebugMode — shared process-wide DEBUG feature gate
// pos:    L0 source of truth for debug logging, transcript capture, and DTO exposure
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/** Preserve Cortex's established DEBUG semantics: every non-empty value enables the mode. */
export function isDebugMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DEBUG);
}
