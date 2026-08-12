// input:  Tauri opener, native-shell detection, browser location
// output: validated cross-shell HTTP(S) navigation
// pos:    Opens authorization pages outside the current workflow
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { openUrl } from '@tauri-apps/plugin-opener';
import { isNativeShell } from './desktop-config';

export interface ExternalNavigationDependencies {
  isNative: () => boolean;
  openNative: (url: string) => Promise<void>;
  navigate: (url: string) => void;
}

const DEFAULT_DEPENDENCIES: ExternalNavigationDependencies = {
  isNative: isNativeShell,
  openNative: openUrl,
  navigate: url => window.location.assign(url),
};

function validatedHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // The stable error below is shared by malformed and unsupported URLs.
  }
  throw new Error('Only HTTP(S) authorization URLs are supported.');
}

export async function openExternalUrl(
  value: string,
  dependencies: ExternalNavigationDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const url = validatedHttpUrl(value);
  if (dependencies.isNative()) {
    try {
      await dependencies.openNative(url);
      return;
    } catch {
      // Frontend OTA may run on an older shell without the opener plugin.
    }
  }
  dependencies.navigate(url);
}
