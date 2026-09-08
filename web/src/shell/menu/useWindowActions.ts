// input:  the native bridge and the persisted webview zoom level
// output: window chrome, zoom and devtools operations for the menu bar and caption buttons
// pos:    Native window-control adapter for the app-drawn title bar
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useCallback, useEffect, useState } from 'react';
import { safeInvoke } from '@/lib/native-bridge';

// The shell builds exactly one window under this label (desktop/src-tauri/src/lib.rs), and every
// `plugin:window|*` command is addressed by label — see node_modules/@tauri-apps/api/window.js.
const WINDOW_LABEL = 'main';
const ZOOM_KEY = 'cortex:webview-zoom';
const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
const DEFAULT_ZOOM = 1;

function readZoom(): number {
  try {
    const raw = Number(window.localStorage.getItem(ZOOM_KEY));
    return ZOOM_STEPS.includes(raw as (typeof ZOOM_STEPS)[number]) ? raw : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM;
  }
}

/** Nearest step in the given direction; clamps at both ends so repeated presses are harmless. */
export function stepZoom(current: number, direction: -1 | 1): number {
  const index = ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number]);
  const from = index === -1 ? ZOOM_STEPS.indexOf(DEFAULT_ZOOM) : index;
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + direction));
  return ZOOM_STEPS[next]!;
}

export interface WindowActions {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  startDragging: () => void;
  isMaximized: boolean;
  toggleFullscreen: () => void;
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  toggleDevTools: () => void;
}

export function useWindowActions(): WindowActions {
  const [isMaximized, setIsMaximized] = useState(false);
  const [zoom, setZoom] = useState<number>(readZoom);

  // Re-read the maximize state on every resize: the window can also be maximized by an OS gesture
  // (double-clicking the drag region, Aero Snap, the keyboard), none of which route through us.
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const result = await safeInvoke('plugin:window|is_maximized', { label: WINDOW_LABEL });
      if (alive && result.ok) setIsMaximized(result.value);
    };
    void sync();
    window.addEventListener('resize', sync);
    return () => {
      alive = false;
      window.removeEventListener('resize', sync);
    };
  }, []);

  const applyZoom = useCallback((value: number) => {
    setZoom(value);
    try {
      window.localStorage.setItem(ZOOM_KEY, String(value));
    } catch {
      /* persistence is best-effort */
    }
    void safeInvoke('plugin:webview|set_webview_zoom', { label: WINDOW_LABEL, value });
  }, []);

  // Re-apply the stored zoom on mount: `set_webview_zoom` is per-process, so a relaunch starts at 1.
  useEffect(() => {
    if (zoom !== DEFAULT_ZOOM) void safeInvoke('plugin:webview|set_webview_zoom', { label: WINDOW_LABEL, value: zoom });
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFullscreen = useCallback(() => {
    void (async () => {
      const current = await safeInvoke('plugin:window|is_fullscreen', { label: WINDOW_LABEL });
      const value = current.ok ? !current.value : true;
      await safeInvoke('plugin:window|set_fullscreen', { label: WINDOW_LABEL, value });
    })();
  }, []);

  return {
    minimize: () => void safeInvoke('plugin:window|minimize', { label: WINDOW_LABEL }),
    toggleMaximize: () => void safeInvoke('plugin:window|toggle_maximize', { label: WINDOW_LABEL }),
    close: () => void safeInvoke('plugin:window|close', { label: WINDOW_LABEL }),
    startDragging: () => void safeInvoke('plugin:window|start_dragging', { label: WINDOW_LABEL }),
    isMaximized,
    toggleFullscreen,
    zoom,
    zoomIn: () => applyZoom(stepZoom(zoom, 1)),
    zoomOut: () => applyZoom(stepZoom(zoom, -1)),
    zoomReset: () => applyZoom(DEFAULT_ZOOM),
    toggleDevTools: () => void safeInvoke('plugin:webview|internal_toggle_devtools', { label: WINDOW_LABEL }),
  };
}
