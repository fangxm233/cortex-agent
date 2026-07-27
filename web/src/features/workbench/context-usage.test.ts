// input:  persisted/live context snapshots, raw SSE payloads, token counts
// output: validation, snapshot precedence, formatting, and progress regressions
// pos:    Pure specification for context usage state and presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import {
  contextUsageFromLivePayload,
  contextUsageViewModel,
  resolveContextUsage,
  shouldShowContextUsage,
} from './context-usage';

const snapshot = {
  usedTokens: 60000,
  contextWindow: 200000,
  percent: 30,
  accuracy: 'estimate' as const,
  updatedAt: '2026-07-27T12:00:00.000Z',
};

describe('context usage snapshot + delta', () => {
  it('uses the live snapshot once present and otherwise restores the query snapshot', () => {
    const live = { ...snapshot, usedTokens: null, percent: null, updatedAt: '2026-07-27T12:01:00.000Z' };
    expect(resolveContextUsage(live, snapshot)).toEqual(live);
    expect(resolveContextUsage(null, snapshot)).toEqual(snapshot);
    expect(resolveContextUsage(null, null)).toBeNull();
  });

  it('accepts the typed SSE payload and rejects malformed windows or accuracy', () => {
    expect(contextUsageFromLivePayload({ ...snapshot, sessionId: 's1', channel: 'web:s1' })).toEqual(snapshot);
    expect(contextUsageFromLivePayload({ ...snapshot, contextWindow: 0 })).toBeNull();
    expect(contextUsageFromLivePayload({ ...snapshot, accuracy: 'maybe' })).toBeNull();
    expect(contextUsageFromLivePayload(null)).toBeNull();
  });

  it('shows an unavailable control for PI, hides unsupported empty sessions, and allows future backends with data', () => {
    expect(shouldShowContextUsage('pi', null)).toBe(true);
    expect(shouldShowContextUsage('claude', null)).toBe(false);
    expect(shouldShowContextUsage('claude', snapshot)).toBe(true);
  });
});

describe('contextUsageViewModel', () => {
  it('formats current/max compactly, full values exactly, and preserves percentage', () => {
    expect(contextUsageViewModel(snapshot)).toEqual({
      compact: '60k / 200k',
      current: '60,000',
      maximum: '200,000',
      percentLabel: '30%',
      progress: 30,
      estimated: true,
    });
  });

  it('clamps only the progress fill while retaining the reported percentage', () => {
    expect(contextUsageViewModel({ ...snapshot, usedTokens: 220000, percent: 110 })).toMatchObject({
      compact: '220k / 200k', percentLabel: '110%', progress: 100,
    });
  });

  it('keeps post-compaction nulls explicit instead of inventing current usage', () => {
    expect(contextUsageViewModel({ ...snapshot, usedTokens: null, percent: null })).toEqual({
      compact: '— / 200k', current: '—', maximum: '200,000', percentLabel: '—',
      progress: null, estimated: true,
    });
    expect(contextUsageViewModel(null)).toMatchObject({ compact: '— / —', current: '—', maximum: '—' });
  });
});
