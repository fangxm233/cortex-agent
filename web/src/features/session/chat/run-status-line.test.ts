import { describe, expect, it } from 'vitest';
import { en } from '@/i18n';
import { runStatusLine, runStatusText, type RunStatusLineInput } from './run-status-line';
import { deriveSessionRunStatus } from '@/features/session/list/session-run-status';

const idleAfterRun = deriveSessionRunStatus({ running: false, backgroundRunning: false, hasRun: true });

describe('runStatusText', () => {
  it('prints label, elapsed, turns and the finalized cost once a run is done', () => {
    expect(runStatusText({ status: idleAfterRun, elapsed: '4s', turns: 3, cost: 0.5, waitingOn: 0 }, en))
      .toBe('idle · 4s · 3 turns · $0.50');
  });

  it('leaves the cost off while running and dashes what is still unknown', () => {
    const running = deriveSessionRunStatus({ running: true, backgroundRunning: false, hasRun: true });
    expect(runStatusText({ status: running, elapsed: '—', turns: null, cost: 1, waitingOn: 0 }, en))
      .toBe('Running · — · —');
  });

  it('reads a never-run session as bare idle, still naming what it waits on', () => {
    const fresh = deriveSessionRunStatus({ running: false, backgroundRunning: false, hasRun: false });
    expect(runStatusText({ status: fresh, elapsed: '—', turns: null, cost: null, waitingOn: 2 }, en))
      .toBe('idle · waiting on 2');
  });
});

const base: RunStatusLineInput = {
  isDraft: false, running: true, backgroundRunning: false, starting: false, turns: 1, cost: null,
  turnClock: { startMs: 0, lastMs: 2000 }, waitingOn: 0, browserDevice: null, turnProgressStarted: true,
};

describe('runStatusLine', () => {
  it('ticks the clock only while the turn runs', () => {
    const line = runStatusLine(base, en, 'en');
    expect(line.active).toBe(true);
    expect(line.text).toBe('Running · 2s · 1 turns');
    expect(line.liveText?.(5000)).toBe('Running · 5s · 1 turns');
    expect(runStatusLine({ ...base, running: false }, en, 'en').liveText).toBeUndefined();
  });

  it('reads a locally queued message as running before the session event lands', () => {
    expect(runStatusLine({ ...base, running: false, starting: true }, en, 'en').active).toBe(true);
  });

  it('says the browser is starting until the turn shows progress', () => {
    const starting = runStatusLine({ ...base, browserDevice: 'desk', turnProgressStarted: false }, en, 'en');
    expect(starting).toEqual({ active: true, text: en.wbBrowserStarting.replace('{device}', 'desk') });
  });
});
