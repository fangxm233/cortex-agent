// input:  native bridge, platform, viewport events and stored zoom
// output: observable window state and failure-reporting actions
// pos:    Native controls for menus and app-drawn window buttons
// >>> Once updated, update this header and parent CORTEX.md <<<
import { useCallback, useEffect, useRef, useState } from 'react';
import { safeInvoke } from '@/lib/native-bridge';
import { desktopPlatform } from '@/lib/desktop-platform';
import { useToastOptional } from '@/design/Toast';
import { useVocab } from '@/i18n';
import { checked, createFullscreenController } from './window-commands';

const LABEL = { label: 'main' };
const ZOOM_KEY = 'cortex:webview-zoom';
const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
const DEFAULT_ZOOM = 1;
type ReportFailure = () => void;
// Route frames can remount while fullscreen; keep the restore state window-scoped.
let fullscreenController: ReturnType<typeof createFullscreenController> | undefined;

function readZoom(): number {
  try {
    const raw = Number(window.localStorage.getItem(ZOOM_KEY));
    return ZOOM_STEPS.includes(raw as (typeof ZOOM_STEPS)[number]) ? raw : DEFAULT_ZOOM;
  } catch { return DEFAULT_ZOOM; }
}

export function stepZoom(current: number, direction: -1 | 1): number {
  const index = ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number]);
  const from = index === -1 ? ZOOM_STEPS.indexOf(DEFAULT_ZOOM) : index;
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + direction))]!;
}

function useWindowState() {
  const [state, setState] = useState({ isMaximized: false, isFullscreen: false });
  const alive = useRef(false);
  const sync = useCallback(async () => {
    const [max, full] = await Promise.all([
      safeInvoke('plugin:window|is_maximized', LABEL), safeInvoke('plugin:window|is_fullscreen', LABEL),
    ]);
    if (alive.current) setState(previous => ({
      isMaximized: max.ok ? max.value : previous.isMaximized,
      isFullscreen: full.ok ? full.value : previous.isFullscreen,
    }));
  }, []);
  useEffect(() => {
    alive.current = true;
    void sync();
    window.addEventListener('resize', sync);
    window.addEventListener('focus', sync);
    return () => {
      alive.current = false;
      window.removeEventListener('resize', sync);
      window.removeEventListener('focus', sync);
    };
  }, [sync]);
  return { ...state, sync };
}

function useZoom(report: ReportFailure) {
  const [zoom, setZoom] = useState(readZoom);
  const busy = useRef(false);
  const apply = useCallback(async (value: number) => {
    if (busy.current) return;
    busy.current = true;
    try {
      checked(await safeInvoke('plugin:webview|set_webview_zoom', { ...LABEL, value }));
      setZoom(value);
      try { window.localStorage.setItem(ZOOM_KEY, String(value)); } catch { /* optional persistence */ }
    } catch { report(); } finally { busy.current = false; }
  }, [report]);
  useEffect(() => {
    const initial = readZoom();
    if (initial !== DEFAULT_ZOOM) void apply(initial);
  }, [apply]);
  return { zoom, zoomIn: () => void apply(stepZoom(zoom, 1)),
    zoomOut: () => void apply(stepZoom(zoom, -1)), zoomReset: () => void apply(DEFAULT_ZOOM) };
}

function escapeIsAvailable(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return false;
  // Let Radix dialogs and menu dismissal consume their Escape first.
  return !document.querySelector('[role="dialog"], [role="menu"], [role="alertdialog"]');
}

function useFullscreen(isFullscreen: boolean, sync: () => Promise<void>, report: ReportFailure) {
  const controller = fullscreenController ??= createFullscreenController(desktopPlatform());
  const run = useCallback(async (exitOnly = false) => {
    try { await (exitOnly ? controller.exit() : controller.toggle()); }
    catch { report(); }
    finally { await sync(); }
  }, [controller, report, sync]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (!isFullscreen || !escapeIsAvailable(event)) return;
      event.preventDefault();
      void run(true);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [isFullscreen, run]);
  return () => void run();
}

export interface WindowActions {
  minimize: () => void; toggleMaximize: () => void; close: () => void; startDragging: () => void;
  isMaximized: boolean; isFullscreen: boolean; toggleFullscreen: () => void;
  zoom: number; zoomIn: () => void; zoomOut: () => void; zoomReset: () => void;
  toggleDevTools: () => void;
}

export function useWindowActions(): WindowActions {
  const L = useVocab();
  const toast = useToastOptional();
  const report = useCallback(() => { toast?.toast({ title: L.windowActionFailed,
    description: L.windowActionFailedHint, tone: 'failed' }); }, [L, toast]);
  const { sync, ...state } = useWindowState();
  const toggleFullscreen = useFullscreen(state.isFullscreen, sync, report);
  const zoom = useZoom(report);
  type Action = 'minimize' | 'toggle_maximize' | 'close' | 'start_dragging';
  const act = (command: Action) => {
    void safeInvoke(`plugin:window|${command}`, LABEL).then(checked).catch(report);
  };
  return {
    ...state, ...zoom, toggleFullscreen,
    minimize: () => act('minimize'), toggleMaximize: () => act('toggle_maximize'),
    close: () => act('close'), startDragging: () => act('start_dragging'),
    toggleDevTools: () => { void safeInvoke('plugin:webview|internal_toggle_devtools', LABEL)
      .then(checked).catch(() => toast?.toast({ title: L.windowDevtoolsFailed,
        description: L.windowDevtoolsFailedHint, tone: 'failed' })); },
  };
}
