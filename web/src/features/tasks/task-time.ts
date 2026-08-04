// input:  A task store ISO timestamp (`completed-at`)
// output: Local `YYYY-MM-DD HH:mm` label, or null when absent
// pos:    Shared task timestamp formatter for desktop and mobile
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// The task store writes `completed-at` as a full ISO-8601 instant (task-completion.ts). Both
// surfaces render it in the viewer's local wall clock — never the raw ISO, which is unreadable in a
// pill or a right-aligned field column. Null (not a fabricated placeholder) when there is no source.

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `2026-08-03 14:22` in local time; null when the timestamp is missing or unparseable. */
export function formatTaskTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
