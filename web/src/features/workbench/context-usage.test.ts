// input:  persisted/live context snapshots, raw SSE payloads, token counts
// output: payload validation, snapshot precedence, and progress-state regressions
// pos:    Pure specification for context usage state and presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import {
  contextUsageFromLivePayload,
  contextUsageViewModel,
  resolveContextUsage,
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
});

describe('contextUsageViewModel', () => {
  it('clamps only the progress fill while retaining the reported percentage', () => {
    expect(contextUsageViewModel({ ...snapshot, usedTokens: 220000, percent: 110 }).progress).toBe(100);
  });

  it('keeps post-compaction nulls explicit instead of inventing current usage', () => {
    expect(contextUsageViewModel({ ...snapshot, usedTokens: null, percent: null }).progress).toBeNull();
    expect(contextUsageViewModel(null).progress).toBeNull();
  });
});
