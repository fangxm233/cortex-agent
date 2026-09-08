// input:  platform and title-bar flags injected by the native shell before the bundle runs
// output: platform detection and the window-chrome mode the SPA must draw
// pos:    Platform adapter for the app-drawn title bar
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// The Rust shell bakes these into the initialization script (desktop/src-tauri/src/lib.rs), so they
// are readable synchronously before React mounts — the top bar must not flash the wrong chrome.
//
// `titleBarMode` is a CAPABILITY flag, not a platform guess. The shell decides whether it stripped
// the native decorations, and it only does so once a frontend new enough to draw its own is
// installed. A frontend that finds 'native' must not draw caption buttons; a frontend rolled back
// below the gate sees 'native' again and behaves like the browser build.

export type DesktopPlatform = 'macos' | 'windows' | 'linux';

/** How the window chrome is drawn.
 *  - `custom`  — decorations off; the SPA draws the caption buttons (Windows / Linux)
 *  - `overlay` — native decorations kept, content extends under them (macOS traffic lights)
 *  - `native`  — the OS draws everything, or we are in a browser: draw no chrome at all */
export type TitleBarMode = 'custom' | 'overlay' | 'native';

function flag(name: string): unknown {
  return (globalThis as unknown as Record<string, unknown>)[name];
}

export function desktopPlatform(): DesktopPlatform | null {
  const value = flag('__CORTEX_PLATFORM__');
  return value === 'macos' || value === 'windows' || value === 'linux' ? value : null;
}

export function titleBarMode(): TitleBarMode {
  const value = flag('__CORTEX_TITLEBAR__');
  return value === 'custom' || value === 'overlay' ? value : 'native';
}

/** True when the OS puts the primary modifier on Cmd rather than Ctrl. Falls back to the user agent
 *  so the browser build still renders ⌘ accelerators correctly on a Mac. */
export function usesCommandKey(): boolean {
  const platform = desktopPlatform();
  if (platform) return platform === 'macos';
  return /Mac|iPhone|iPad/i.test(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent ?? '');
}

/** Space the caption buttons need at the right edge (3 × 46px, Windows convention). */
export function captionInsetRight(): number {
  return titleBarMode() === 'custom' ? 138 : 0;
}

/** Space the macOS traffic lights need at the left edge. */
export function captionInsetLeft(): number {
  return titleBarMode() === 'overlay' ? 78 : 0;
}
