export const DEFAULT_DEBUG_TOOL_WARNING_CHARS = 10_000;

/** Preserve Cortex's established DEBUG semantics: every non-empty value enables the mode. */
export function isDebugMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DEBUG);
}

export function debugToolWarningChars(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.CORTEX_DEBUG_TOOL_WARNING_CHARS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DEBUG_TOOL_WARNING_CHARS;
}

/**
 * The large-payload warning is a hint on a UI chip — "opening this will be slow" — so it is
 * measured on the serialized JSON line the row was read from, which every caller already holds.
 *
 * It used to re-serialize the parsed input with `JSON.stringify(value, null, 2)` and split the
 * result into an array of code points, once per tool row per parse, only to compare a number
 * against this threshold. That was 4.65% of the server's CPU, and it put one array slot plus one
 * string object per character straight into the GC's path. A serialized row is within a small
 * constant factor of what the modal renders, which is all a warning chip ever needed.
 */
export function isOverDebugToolWarningChars(
  chars: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return chars > debugToolWarningChars(env);
}
