// input:  external URL helper with injected native/browser seams
// output: browser, native, fallback, and scheme regressions
// pos:    Verifies authorization links leave every supported shell
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it, vi } from 'vitest';
import {
  openExternalUrl,
  type ExternalNavigationDependencies,
} from './external-navigation';

function dependencies(native: boolean, nativeFailure = false) {
  const openNative = vi.fn(async () => {
    if (nativeFailure) throw new Error('plugin unavailable');
  });
  const navigate = vi.fn();
  const value: ExternalNavigationDependencies = {
    isNative: () => native,
    openNative,
    navigate,
  };
  return { value, openNative, navigate };
}

describe('openExternalUrl', () => {
  it('navigates the current page in a browser', async () => {
    const fixture = dependencies(false);

    await openExternalUrl('https://login.example.test/authorize', fixture.value);

    expect(fixture.openNative).not.toHaveBeenCalled();
    expect(fixture.navigate).toHaveBeenCalledWith('https://login.example.test/authorize');
  });

  it('opens the system browser in a current native shell', async () => {
    const fixture = dependencies(true);

    await openExternalUrl('https://login.example.test/authorize', fixture.value);

    expect(fixture.openNative).toHaveBeenCalledWith('https://login.example.test/authorize');
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it('falls back to current-page navigation in an older native shell', async () => {
    const fixture = dependencies(true, true);

    await openExternalUrl('https://login.example.test/authorize', fixture.value);

    expect(fixture.openNative).toHaveBeenCalledOnce();
    expect(fixture.navigate).toHaveBeenCalledWith('https://login.example.test/authorize');
  });

  it('rejects non-HTTP authorization destinations', async () => {
    const fixture = dependencies(false);

    await expect(openExternalUrl('javascript:alert(1)', fixture.value)).rejects.toThrow(
      'Only HTTP(S) authorization URLs are supported.',
    );
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
});
