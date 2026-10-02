import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cascade = vi.hoisted(() => ({ check: vi.fn(() => Promise.resolve({} as never)), connection: 'connected' }));
vi.mock('./manual-update-check', () => ({ checkFrontendUpdates: cascade.check }));
vi.mock('@/features/connection/ConnectionStatusProvider', () => ({ useConnectionStatus: () => cascade.connection }));

import { useShellRecheckCascade } from './useShellRecheckCascade';

function Cascade({ state }: { state: 'idle' | 'prompting' | 'installing' | 'restarting' | 'failed' }) {
  useShellRecheckCascade(state);
  return null;
}

describe('shell re-check cascade', () => {
  beforeEach(() => { cascade.check.mockClear(); cascade.connection = 'connected'; });

  it('uses reconnection when polling missed both installation states', () => {
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<Cascade state="prompting" />); });
    cascade.connection = 'reconnecting';
    act(() => { renderer.update(<Cascade state="prompting" />); });
    cascade.connection = 'connected';
    act(() => { renderer.update(<Cascade state="prompting" />); });
    expect(cascade.check).not.toHaveBeenCalled();
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).toHaveBeenCalledOnce();
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it('re-checks the shell the moment the server is back from restarting', () => {
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<Cascade state="installing" />); });
    expect(cascade.check).not.toHaveBeenCalled();

    act(() => { renderer.update(<Cascade state="restarting" />); });
    expect(cascade.check).not.toHaveBeenCalled();

    // The new server process starts with an empty update state, so `idle` IS "it came back".
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).toHaveBeenCalledTimes(1);

    // And it stays a one-shot — the shell's own 24h timer owns everything after this.
    act(() => { renderer.update(<Cascade state="prompting" />); });
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).toHaveBeenCalledTimes(1);
  });

  it('rechecks when polling missed restarting, but not after a failed install', () => {
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<Cascade state="installing" />); });
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).toHaveBeenCalledOnce();
    act(() => { renderer.update(<Cascade state="installing" />); });
    act(() => { renderer.update(<Cascade state="failed" />); });
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it('does not re-check when no install ever ran', () => {
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<Cascade state="prompting" />); });
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).not.toHaveBeenCalled();
  });
});
