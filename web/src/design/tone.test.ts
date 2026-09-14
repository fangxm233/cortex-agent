import { describe, expect, it } from 'vitest';
import { statusTone, type Tone } from './tone';

const LEGAL_STATUS_TONES: Readonly<Record<string, Tone>> = {
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

describe('statusTone', () => {
  it('maps every supported contract status to its canonical tone', () => {
    for (const [status, tone] of Object.entries(LEGAL_STATUS_TONES)) {
      expect(statusTone(status), status).toBe(tone);
    }
  });

  it('uses cancelled for unknown status strings', () => {
    expect(statusTone('future-status')).toBe('cancelled');
  });
});
