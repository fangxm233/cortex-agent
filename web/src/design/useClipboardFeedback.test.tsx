// input:  mocked clipboard outcomes, fake timers, and mounted hook harnesses
// output: regression coverage for success feedback, failures, replacement, and cleanup
// pos:    Unit tests for the shared clipboard-feedback hook
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useClipboardFeedback, type ClipboardFeedback } from './useClipboardFeedback';

function mountHook(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  let value: ClipboardFeedback<string> | null = null;
  function Harness(): null {
    value = useClipboardFeedback<string>(1200);
    return null;
  }
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(<Harness />); });
  return { get: () => value!, unmount: () => act(() => renderer.unmount()) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useClipboardFeedback', () => {
  it('shows feedback only after a successful write and resets it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const hook = mountHook(writeText);
    await act(async () => { expect(await hook.get().copy('value', 'row')).toBe(true); });
    expect(writeText).toHaveBeenCalledWith('value');
    expect(hook.get().copiedKey).toBe('row');
    act(() => { vi.advanceTimersByTime(1200); });
    expect(hook.get().copiedKey).toBeNull();
    hook.unmount();
  });

  it('does not show copied feedback when writing fails', async () => {
    const hook = mountHook(vi.fn().mockRejectedValue(new Error('denied')));
    await act(async () => { expect(await hook.get().copy('value', 'row')).toBe(false); });
    expect(hook.get().copiedKey).toBeNull();
    hook.unmount();
  });

  it('replaces the prior timer and clears timers on unmount', async () => {
    const hook = mountHook(vi.fn().mockResolvedValue(undefined));
    await act(async () => { await hook.get().copy('one', 'first'); });
    await act(async () => { await hook.get().copy('two', 'second'); });
    expect(hook.get().copiedKey).toBe('second');
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
