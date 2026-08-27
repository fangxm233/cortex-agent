// input:  Contract status strings from thread, task, and execution surfaces
// output: One of the five shared visual tones with a cancelled fallback
// pos:    Canonical desktop/mobile status-to-tone mapping
// >>> If I am updated, update my header comment and CORTEX.md <<<

export const TONES = ['running', 'waiting', 'done', 'failed', 'cancelled'] as const;

export type Tone = (typeof TONES)[number];

const STATUS_TONE: Record<string, Tone> = {
  running: 'running',
  open: 'running',
  waiting: 'waiting',
  rate_limited: 'waiting',
  completed: 'done',
  done: 'done',
  failed: 'failed',
  aborted: 'failed',
  cancelled: 'cancelled',
  stale: 'cancelled',
};

export function statusTone(status: string): Tone {
  return STATUS_TONE[status.toLowerCase()] ?? 'cancelled';
}
