// input:  process env plus complete DEBUG tool inputs/results
// output: DEBUG gate, warning threshold, character count, size policy
// pos:    L0 source of truth for process-wide DEBUG behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export const DEFAULT_DEBUG_TOOL_WARNING_CHARS = 10_000;

interface DebugToolDetails {
  toolInput?: unknown;
  toolResult?: { content: string; isError: boolean };
}

/** Preserve Cortex's established DEBUG semantics: every non-empty value enables the mode. */
export function isDebugMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DEBUG);
}

export function debugToolWarningChars(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.CORTEX_DEBUG_TOOL_WARNING_CHARS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DEBUG_TOOL_WARNING_CHARS;
}

function formatDebugValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const encoded = JSON.stringify(value, null, 2);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

export function debugToolCharacterCount(details: DebugToolDetails): number {
  const inputChars = Array.from(formatDebugValue(details.toolInput)).length;
  const resultChars = details.toolResult ? Array.from(details.toolResult.content).length : 0;
  return inputChars + resultChars;
}

export function isDebugToolOverWarningThreshold(
  details: DebugToolDetails,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return debugToolCharacterCount(details) > debugToolWarningChars(env);
}
