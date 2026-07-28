import { describe, expect, it } from 'vitest';
import type { Tone } from './tone';
import { severityTone, type DegradedSeverity } from './degraded';

// Degraded status language (design §5, design 10c): the four degraded variants
// collapse onto three severities whose color semantics are the tested invariant —
// 琥珀(amber)=等待(waiting), 红(red)=需人工(needs-human), 蓝(blue)=transient note.

describe('severityTone', () => {
  it('encodes the 10c color language: amber=waiting, red=human, blue=info', () => {
    const cases: Record<DegradedSeverity, Tone> = {
      waiting: 'waiting', // amber — auto-paused, awaits reset/approval
      human: 'failed', // red — needs human attention
      info: 'running', // blue — transient in-step note (backend fallback)
    };
    for (const [severity, tone] of Object.entries(cases)) {
      expect(severityTone(severity as DegradedSeverity)).toBe(tone);
    }
  });

});
