import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useCommandPalette } from './useCommandPalette';

it('toggles on Ctrl+K and ignores a keydown without a key', () => {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  let open = false;
  function Probe() {
    open = useCommandPalette().open;
    return null;
  }
  act(() => { create(<Probe />); });
  // Chrome dispatches a plain Event named keydown, with no key, when an autofill entry is picked.
  act(() => { target.dispatchEvent(new Event('keydown')); });
  expect(open).toBe(false);
  act(() => { target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'k', ctrlKey: true })); });
  expect(open).toBe(true);
  vi.unstubAllGlobals();
});
