/**
 * Where a turn starts in its backend transcript (a PI or Claude Code JSONL file). Rewinding to the
 * turn cuts the file back to this point. Both backends only append, and the few rewrites they do
 * keep every entry id, so an entry id is a stable cut point where a byte offset is not.
 *
 * `after`: keep through this entry, plus the id-less metadata lines that follow it.
 * `before`: keep only what precedes this entry.
 */
export type TranscriptPosition = { after: string } | { before: string };

/** A turn's cut point in the transcript at `file` (absolute path). */
export type TurnAnchor = TranscriptPosition & { file: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The position `value` carries, or undefined when it is not one. */
export function toTranscriptPosition(value: unknown): TranscriptPosition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (nonEmptyString(row.after)) return { after: row.after };
  if (nonEmptyString(row.before)) return { before: row.before };
  return undefined;
}

/** The anchor `value` carries, or undefined when it is not one. */
export function toTurnAnchor(value: unknown): TurnAnchor | undefined {
  const position = toTranscriptPosition(value);
  const file = (value as Record<string, unknown> | null)?.file;
  return position && nonEmptyString(file) ? { file, ...position } : undefined;
}
