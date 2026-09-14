import { describe, expect, it } from 'vitest';
import { deriveSessionRunStatus } from './session-run-status';

describe('deriveSessionRunStatus', () => {
  it('classifies a foreground run as active metrics without finalized cost', () => {
    expect(deriveSessionRunStatus({ running: true, backgroundRunning: false, hasRun: true })).toEqual({
      phase: 'foreground', active: true, showMetrics: true, showCost: false,
    });
  });

  it('gives a background hold priority over the generic running state', () => {
    expect(deriveSessionRunStatus({ running: true, backgroundRunning: true, hasRun: true })).toEqual({
      phase: 'background', active: true, showMetrics: true, showCost: false,
    });
  });

  it('shows metrics and finalized cost for an idle session with run history', () => {
    expect(deriveSessionRunStatus({ running: false, backgroundRunning: false, hasRun: true })).toEqual({
      phase: 'idle', active: false, showMetrics: true, showCost: true,
    });
  });

  it('keeps a fresh session inactive and free of stale metrics', () => {
    expect(deriveSessionRunStatus({ running: false, backgroundRunning: false, hasRun: false })).toEqual({
      phase: 'fresh', active: false, showMetrics: false, showCost: false,
    });
  });
});
