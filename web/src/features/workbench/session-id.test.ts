import { describe, it, expect } from 'vitest';
import { buildSessionIdRows } from './session-id';

describe('buildSessionIdRows', () => {
  it('returns the Cortex ID row first, then the backend UUID row', () => {
    const rows = buildSessionIdRows({
      cortexId: 'cortex-0042',
      backendUuid: '11111111-2222-3333-4444-555555555555',
      cortexIdLabel: 'Cortex ID',
      backendUuidLabel: 'Backend UUID',
    });
    expect(rows).toEqual([
      { key: 'cortexId', label: 'Cortex ID', value: 'cortex-0042' },
      { key: 'backendUuid', label: 'Backend UUID', value: '11111111-2222-3333-4444-555555555555' },
    ]);
  });

  it('falls back to a dash when an id is missing or blank (never fabricated)', () => {
    const rows = buildSessionIdRows({
      cortexId: null,
      backendUuid: '   ',
      cortexIdLabel: 'Cortex ID',
      backendUuidLabel: 'Backend UUID',
    });
    expect(rows[0].value).toBe('—');
    expect(rows[1].value).toBe('—');
  });

  it('trims surrounding whitespace on real values', () => {
    const rows = buildSessionIdRows({
      cortexId: '  cortex-0007  ',
      backendUuid: '  abc  ',
      cortexIdLabel: 'C',
      backendUuidLabel: 'B',
    });
    expect(rows[0].value).toBe('cortex-0007');
    expect(rows[1].value).toBe('abc');
  });
});
