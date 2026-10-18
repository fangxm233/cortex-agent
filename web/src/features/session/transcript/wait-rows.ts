import type { TranscriptMessage } from '@cortex-agent/ui-contract';

// A `wait_create` call in the chat: the agent armed a waitpoint and is about to end its turn, so the
// session goes idle until an external job signals it. That is the turn's outcome, not one more tool
// call, so it leaves the tool run and becomes a row of its own. History keeps only the call's capped
// summary — `{"label":"…","intent":"…"}` cut at 120 characters — so the fields are read best-effort:
// a cut-off value stays a prefix, a missing one stays null.

export interface WaitpointView {
  label: string | null;
  intent: string | null;
  ts: string | null;
}

export type WaitpointRow = { kind: 'waitpoint'; wait: WaitpointView };

export function isWaitCreateTool(toolName: string | null | undefined): boolean {
  return (toolName?.split('__').at(-1)?.split('.').at(-1) ?? '') === 'wait_create';
}

/** One string field out of possibly cut-off JSON. */
function field(src: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(src);
  if (!m) return null;
  const raw = m[1].replace(/…$/, '').replace(/\\$/, '');
  let value: string;
  try {
    value = JSON.parse(`"${raw}"`) as string;
  } catch {
    value = raw.replace(/\\(.)/g, '$1');
  }
  return value.trim() || null;
}

/** What a wait_create tool row armed; null for every other row. */
export function waitpointOf(m: TranscriptMessage): WaitpointView | null {
  if (m.type !== 'tool' || !isWaitCreateTool(m.toolName)) return null;
  const input = m.toolInput ?? '';
  return { label: field(input, 'label'), intent: field(input, 'intent'), ts: m.ts ?? null };
}
