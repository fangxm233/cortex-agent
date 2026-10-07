import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdleInstaller, type IdleSignal } from '../src/domain/system/server-update-install.js';
import { rebuildHold, releaseNewTurnHold } from '../src/domain/system/rebuild-hold.js';
import {
  _resetServerUpdateStatus, getServerUpdateStatus, queueAutoServerUpdate,
} from '../src/domain/system/update-ui-state.js';

function idleSignal(initiallyIdle: boolean) {
  let idle = initiallyIdle;
  const listeners = new Set<() => void>();
  const signal: IdleSignal = {
    isIdle: () => idle,
    onIdle: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    signal,
    listeners,
    setIdle(next: boolean) {
      idle = next;
      if (next) for (const listener of [...listeners]) listener();
    },
  };
}

function runner() {
  const calls: Array<{ version: string; done: (error: string | null) => void }> = [];
  const run = vi.fn((version: string, done: (error: string | null) => void) => { calls.push({ version, done }); });
  return { run, calls };
}

beforeEach(() => {
  _resetServerUpdateStatus();
  releaseNewTurnHold();
  queueAutoServerUpdate('9999.1.1');
});
afterEach(() => { releaseNewTurnHold(); });

describe('idle-gated server install', () => {
  it('installs at once when idle and holds new turns until the daemon restarts the app', () => {
    const idle = idleSignal(true);
    const r = runner();
    createIdleInstaller(idle.signal, r.run, { supervised: () => true })('9999.1.1');
    expect(r.run).toHaveBeenCalledWith('9999.1.1', expect.any(Function));
    expect(getServerUpdateStatus()).toEqual({ state: 'installing', available: '9999.1.1', auto: true });
    expect(rebuildHold()).toEqual({ phase: 'server-update' });
    r.calls[0].done(null);
    expect(getServerUpdateStatus()).toEqual({ state: 'restarting', available: '9999.1.1', auto: true });
    expect(rebuildHold()).toEqual({ phase: 'server-update' });
  });

  it('waits for the next idle transition while a turn is running', () => {
    const idle = idleSignal(false);
    const r = runner();
    createIdleInstaller(idle.signal, r.run, { supervised: () => true })('9999.1.1');
    expect(r.run).not.toHaveBeenCalled();
    expect(getServerUpdateStatus().state).toBe('waiting');
    expect(rebuildHold()).toBeNull();
    idle.setIdle(true);
    expect(r.run).toHaveBeenCalledTimes(1);
    expect(idle.listeners.size).toBe(0);
    expect(rebuildHold()).toEqual({ phase: 'server-update' });
  });

  it('releases the hold when no daemon will restart the app', () => {
    const r = runner();
    createIdleInstaller(idleSignal(true).signal, r.run, { supervised: () => false })('9999.1.1');
    r.calls[0].done(null);
    expect(getServerUpdateStatus().state).toBe('restarting');
    expect(rebuildHold()).toBeNull();
  });

  it('reports a failed install, releases the hold and can run again', () => {
    const idle = idleSignal(true);
    const r = runner();
    const install = createIdleInstaller(idle.signal, r.run, { supervised: () => true });
    install('9999.1.1');
    r.calls[0].done('npm install -g exited with code 1');
    expect(getServerUpdateStatus()).toEqual({
      state: 'failed', available: '9999.1.1', error: 'npm install -g exited with code 1',
    });
    expect(rebuildHold()).toBeNull();
    install('9999.1.1');
    expect(r.run).toHaveBeenCalledTimes(2);
  });

  it('treats a runner that throws as a failed install', () => {
    const run = vi.fn(() => { throw new Error('spawn failed'); });
    createIdleInstaller(idleSignal(true).signal, run, { supervised: () => true })('9999.1.1');
    expect(getServerUpdateStatus()).toMatchObject({ state: 'failed', error: 'spawn failed' });
    expect(rebuildHold()).toBeNull();
  });
});
