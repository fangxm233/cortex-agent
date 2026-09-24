// input:  BrowserTabState, forwarding API, browser presentation
// output: WebBody
// pos:    Persistent browser preview with extracted glass chrome
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiBase } from '@/lib/desktop-config';
import {
  canForward, listDeviceRemotePorts, listForwardDevices, listRemotePorts, openDeviceForward,
  startForward,
} from './forward';
import {
  VIEWPORT_PRESETS,
  WEB_SANDBOX,
  applyBrowserTitle,
  browserItemName,
  currentUrl,
  frameRefusedEmbedding,
  goBack,
  goForward,
  normalizeBrowserUrl,
  previewOriginConflict,
  pushHistory,
  type BrowserTabState,
} from './browser-target';
import { matchFrameTitleMessage } from './frame-title';
import { BrowserToolbar } from './BrowserToolbar';
import { BrowserEmpty, BrowserNotice, PortsPanel, type PortPickerState } from './BrowserPanels';
import './browser.css';

const INVALID_ADDRESS = 'Not a previewable address — use http(s), a host:port, or a bare port.';
const ORIGIN_CONFLICT = 'Refused: that is this app’s own origin. Previewing it would hand the page your session.';

const EMPTY_PORTS: PortPickerState = { open: false, ports: null, error: null, device: '', devices: [] };

/**
 * ONE web tab. Its state lives in the dock (`features/dock`), which mounts one of these per web tab
 * and keeps them all alive across tab switches — so every mutation goes back through `onUpdate`
 * rather than into local state, and the iframe below survives being hidden.
 */
export function WebBody({ tab, active, onUpdate }: {
  tab: BrowserTabState;
  active: boolean;
  onUpdate: (update: (tab: BrowserTabState) => BrowserTabState) => void;
}): JSX.Element {
  const [ports, setPorts] = useState<PortPickerState>(EMPTY_PORTS);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const nextForwardOperation = useRef(1);
  /** The forward operation this tab is currently waiting on; 0 = none. Any navigation cancels it. */
  const forwardOperation = useRef(0);
  const url = currentUrl(tab.history);
  const forbiddenOrigins = useMemo(
    () => [typeof window === 'undefined' ? '' : window.location.origin, apiBase()],
    [],
  );

  const navigate = (raw: string): void => {
    const next = normalizeBrowserUrl(raw);
    if (next === null) return onUpdate((entry) => rejectNavigation(entry, INVALID_ADDRESS));
    if (previewOriginConflict(next, forbiddenOrigins)) {
      return onUpdate((entry) => rejectNavigation(entry, ORIGIN_CONFLICT));
    }
    forwardOperation.current = 0;
    onUpdate((entry) => navigateTab(entry, next));
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current;
      if (!frame) return;
      const message = matchFrameTitleMessage(new Map([[tab.id, frame]]), event.source, event.data, event.origin);
      if (!message) return;
      onUpdate((entry) => applyBrowserTitle(entry, message.title, message.timeOrigin, message.phase));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [tab.id, onUpdate]);

  useEffect(() => {
    if (active && url === null) inputRef.current?.focus();
  }, [active, url]);

  const step = (dir: 'back' | 'forward'): void => {
    forwardOperation.current = 0;
    onUpdate((entry) => {
      const history = dir === 'back' ? goBack(entry.history) : goForward(entry.history);
      return openDocument(entry, { history, draft: currentUrl(history) ?? '' });
    });
  };

  const reload = (): void => {
    forwardOperation.current = 0;
    onUpdate((entry) => openDocument(entry, { reloadNonce: entry.reloadNonce + 1 }));
  };

  const onFrameLoad = (): void => {
    let reachable = false;
    try {
      reachable = !!frameRef.current?.contentDocument;
    } catch {
      reachable = false;
    }
    const refused = frameRefusedEmbedding({ loaded: true, documentReachable: reachable });
    onUpdate((entry) => ({ ...entry, refused }));
  };

  const loadPorts = (device: string): void => {
    setPorts((state) => ({ ...state, ports: null, error: null }));
    const request = device === '' ? listRemotePorts() : listDeviceRemotePorts(device);
    request
      .then((next) => setPorts((state) => state.device === device ? { ...state, ports: next } : state))
      .catch((error: Error) => setPorts((state) => state.device === device ? { ...state, error: error.message } : state));
  };

  const pickDevice = (device: string): void => {
    setPorts((state) => ({ ...state, device }));
    loadPorts(device);
  };

  const togglePorts = (): void => {
    if (ports.open) return setPorts((state) => ({ ...state, open: false }));
    setPorts((state) => ({ ...state, open: true }));
    listForwardDevices()
      .then((devices) => {
        const device = ports.device === '' || devices.some((entry) => entry.device === ports.device) ? ports.device : '';
        setPorts((state) => ({ ...state, devices, device }));
        loadPorts(device);
      })
      .catch(() => { setPorts((state) => ({ ...state, devices: [], device: '' })); loadPorts(''); });
  };

  const openPort = async (port: number): Promise<void> => {
    const device = ports.device;
    const operationId = nextForwardOperation.current++;
    forwardOperation.current = operationId;
    setPorts((state) => ({ ...state, open: false }));
    onUpdate((entry) => ({
      ...entry,
      pageTitle: null,
      forward: { status: 'connecting', operationId, device, originalPort: port },
      rejected: null,
    }));
    try {
      const serverPort = device === '' ? port : (await openDeviceForward(device, port)).localPort;
      if (forwardOperation.current !== operationId) return;
      const rawTarget = canForward() ? (await startForward(serverPort)).url : `http://127.0.0.1:${serverPort}/`;
      if (forwardOperation.current !== operationId) return;
      const target = normalizeBrowserUrl(rawTarget);
      if (!target) throw new Error(INVALID_ADDRESS);
      if (previewOriginConflict(target, forbiddenOrigins)) throw new Error(ORIGIN_CONFLICT);
      forwardOperation.current = 0;
      onUpdate((entry) => completeForward(entry, operationId, device, port, target));
    } catch (error) {
      if (forwardOperation.current !== operationId) return;
      forwardOperation.current = 0;
      onUpdate((entry) => failForward(entry, operationId, (error as Error).message));
    }
  };

  const viewport = VIEWPORT_PRESETS.find((preset) => preset.id === tab.viewportId) ?? VIEWPORT_PRESETS[0]!;

  return (
    <div data-browser-workspace={tab.id} className="browser-workspace">
      <BrowserToolbar
        tab={tab}
        url={url}
        inputRef={inputRef}
        portsOpen={ports.open}
        onStep={step}
        onReload={reload}
        onDraft={(draft) => onUpdate((entry) => ({ ...entry, draft }))}
        onNavigate={() => navigate(tab.draft)}
        onResetDraft={() => onUpdate((entry) => ({ ...entry, draft: url ?? '' }))}
        onViewport={(viewportId) => onUpdate((entry) => ({ ...entry, viewportId }))}
        onTogglePorts={togglePorts}
      />
      {ports.open && <PortsPanel id={`browser-ports-${tab.id}`} state={ports} onDevice={pickDevice} onPort={openPort} />}
      <BrowserNotice tab={tab} url={url} />
      <div className="browser-stage">
        {url === null ? <BrowserEmpty /> : (
          // The frame keeps an opaque fill: it renders a real page, which has to occlude the colour
          // mesh the way any document body does.
          <iframe
            key={`${tab.documentGeneration}:${tab.reloadNonce}`}
            ref={(node) => { frameRef.current = node; }}
            data-browser-frame={tab.id}
            onLoad={onFrameLoad}
            src={url}
            title={browserItemName(url)}
            sandbox={WEB_SANDBOX}
            style={{ border: 'none', width: viewport.width ?? '100%', flex: viewport.width ? 'none' : 1, minHeight: '100%', background: 'var(--proto-card)' }}
          />
        )}
      </div>
    </div>
  );
}

function openDocument(
  tab: BrowserTabState,
  changes: Partial<BrowserTabState>,
  forward = tab.forward?.status === 'ready' ? tab.forward : null,
): BrowserTabState {
  return {
    ...tab,
    ...changes,
    documentGeneration: tab.documentGeneration + 1,
    pageTitle: null,
    titleTimeOrigin: 0,
    forward,
    refused: false,
  };
}

function navigateTab(tab: BrowserTabState, target: string): BrowserTabState {
  const history = pushHistory(tab.history, target);
  const changes = { history, draft: target, rejected: null };
  if (history === tab.history) {
    const forward = tab.forward?.status === 'ready' ? tab.forward : null;
    return { ...tab, ...changes, forward };
  }
  return openDocument(tab, changes);
}

function rejectNavigation(tab: BrowserTabState, message: string): BrowserTabState {
  return { ...tab, rejected: message };
}

function completeForward(
  tab: BrowserTabState,
  operationId: number,
  device: string,
  originalPort: number,
  targetUrl: string,
): BrowserTabState {
  if (tab.forward?.status !== 'connecting' || tab.forward.operationId !== operationId) return tab;
  const history = pushHistory(tab.history, targetUrl);
  const forward = { status: 'ready' as const, device, originalPort, targetUrl };
  return openDocument(tab, { history, draft: targetUrl, rejected: null }, forward);
}

function failForward(tab: BrowserTabState, operationId: number, message: string): BrowserTabState {
  if (tab.forward?.status !== 'connecting' || tab.forward.operationId !== operationId) return tab;
  return { ...tab, forward: null, rejected: message };
}
