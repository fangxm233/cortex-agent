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
