// input:  one web tab's state, frame titles, app origins and port forwarding
// output: that tab's toolbar, port picker and live frame
// pos:    Desktop body for a single web tab; the dock owns the tab list
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiBase } from '@/lib/desktop-config';
import { openExternalUrl } from '@/lib/external-navigation';
import {
  canForward, listDeviceRemotePorts, listForwardDevices, listRemotePorts, openDeviceForward,
  startForward, type ForwardDevice, type ListeningPort,
} from './forward';
import {
  FRAME_REFUSED_HINT,
  VIEWPORT_PRESETS,
  WEB_SANDBOX,
  applyBrowserTitle,
  browserItemName,
  browserTabForwardSource,
  canGoBack,
  canGoForward,
  currentUrl,
  frameRefusedEmbedding,
  goBack,
  goForward,
  normalizeBrowserUrl,
  previewOriginConflict,
  pushHistory,
  type BrowserTabState,
  type ViewportPreset,
} from './browser-target';
import { matchFrameTitleMessage } from './frame-title';

const MONO = "'IBM Plex Mono',monospace";
const EMPTY_HINT = 'Enter a port or a URL. Remote dev servers appear here once forwarded.';
const INVALID_ADDRESS = 'Not a previewable address — use http(s), a host:port, or a bare port.';
const ORIGIN_CONFLICT = 'Refused: that is this app’s own origin. Previewing it would hand the page your session.';

interface PortPickerState {
  open: boolean;
  ports: ListeningPort[] | null;
  error: string | null;
  device: string;
  devices: ForwardDevice[];
}

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
    <div data-browser-workspace={tab.id} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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
      {ports.open && <PortsPanel state={ports} onDevice={pickDevice} onPort={openPort} />}
      <BrowserNotice tab={tab} url={url} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--proto-gray)', display: 'flex', justifyContent: 'center' }}>
        {url === null ? <div style={EMPTY_STYLE}>{EMPTY_HINT}</div> : (
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

function BrowserToolbar({ tab, url, inputRef, portsOpen, onStep, onReload, onDraft, onNavigate, onResetDraft, onViewport, onTogglePorts }: {
  tab: BrowserTabState;
  url: string | null;
  inputRef: React.RefObject<HTMLInputElement>;
  portsOpen: boolean;
  onStep: (dir: 'back' | 'forward') => void;
  onReload: () => void;
  onDraft: (draft: string) => void;
  onNavigate: () => void;
  onResetDraft: () => void;
  onViewport: (id: ViewportPreset['id']) => void;
  onTogglePorts: () => void;
}): JSX.Element {
  const origin = browserTabForwardSource(tab);
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-card)' }}>
      <NavBtn title="Back" disabled={!canGoBack(tab.history)} onClick={() => onStep('back')}>‹</NavBtn>
      <NavBtn title="Forward" disabled={!canGoForward(tab.history)} onClick={() => onStep('forward')}>›</NavBtn>
      <NavBtn title="Reload" disabled={url === null} onClick={onReload}>⟳</NavBtn>
      <div style={ADDRESS_FIELD_STYLE}>
        {origin && (
          <span data-forward-origin={origin} title={`Forwarded from ${origin}`} style={ADDRESS_BADGE_STYLE}>
            {origin}<span style={{ opacity: 0.65 }}>→</span>
          </span>
        )}
        <input
          ref={inputRef}
          value={tab.draft}
          spellCheck={false}
          placeholder="Port or http://host:port"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onNavigate();
            if (event.key === 'Escape') onResetDraft();
          }}
          style={{ flex: 1, minWidth: 0, height: '100%', padding: 0, border: 'none', background: 'transparent', color: 'var(--proto-ink)', font: `500 11px ${MONO}`, outline: 'none' }}
        />
      </div>
      <select title="Viewport width" value={tab.viewportId} onChange={(event) => onViewport(event.target.value as ViewportPreset['id'])} style={SELECT_STYLE}>
        {VIEWPORT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
      </select>
      <button type="button" title="Ports listening on the server or a connected device" onClick={onTogglePorts} style={{ ...PORT_BUTTON, border: portsOpen ? '1.5px solid var(--proto-accent)' : '1px solid var(--proto-line)', background: portsOpen ? 'var(--proto-accent-bg)' : 'var(--proto-card)', color: portsOpen ? 'var(--proto-accent)' : 'var(--proto-muted)' }}>Ports</button>
      <NavBtn title="Open in system browser" disabled={url === null} onClick={() => { if (url) void openExternalUrl(url); }}>↗</NavBtn>
    </div>
  );
}

function PortsPanel({ state, onDevice, onPort }: {
  state: PortPickerState;
  onDevice: (device: string) => void;
  onPort: (port: number) => Promise<void>;
}): JSX.Element {
  return (
    <div style={{ flex: 'none', maxHeight: 190, overflow: 'auto', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-card)' }}>
      {state.devices.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px solid var(--proto-line)' }}>
          <DeviceTab active={state.device === ''} onClick={() => onDevice('')}>server</DeviceTab>
          {state.devices.map((device) => <DeviceTab key={device.device} active={state.device === device.device} onClick={() => onDevice(device.device)}>{device.device}</DeviceTab>)}
        </div>
      )}
      {state.error ? <PortsNote>{state.error}</PortsNote>
        : state.ports === null ? <PortsNote>Loading…</PortsNote>
          : state.ports.length === 0 ? <PortsNote>Nothing is listening on {state.device === '' ? 'the server’s' : `${state.device}’s`} loopback.</PortsNote>
            : state.ports.map((port) => <PortRow key={`${state.device}:${port.port}`} port={port} onClick={() => void onPort(port.port)} />)}
      {!canForward() && <PortsNote>Forwarding needs the desktop app — these open as plain localhost here.</PortsNote>}
    </div>
  );
}

function BrowserNotice({ tab, url }: { tab: BrowserTabState; url: string | null }): JSX.Element | null {
  if (tab.refused && url) {
    return (
      <div style={NOTICE_STYLE}>
        <span>{FRAME_REFUSED_HINT}</span>
        <button type="button" data-action="open-external" onClick={() => void openExternalUrl(url)} style={NOTICE_BUTTON}>↗</button>
      </div>
    );
  }
  if (!tab.rejected) return null;
  return <div style={{ ...NOTICE_STYLE, color: 'var(--proto-danger)' }}>{tab.rejected}</div>;
}

function PortRow({ port, onClick }: { port: ListeningPort; onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} style={PORT_ROW_STYLE}>
      <span style={{ flex: 'none', width: 54, color: 'var(--proto-accent)' }}>{port.port}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--proto-muted)' }}>{port.process ?? ''}</span>
      <span style={{ flex: 'none', color: 'var(--proto-muted-2)' }}>{port.address}</span>
    </button>
  );
}

function DeviceTab({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }): JSX.Element {
  return <button type="button" onClick={onClick} style={{ ...DEVICE_BUTTON, border: active ? '1.5px solid var(--proto-accent)' : '1px solid var(--proto-line)', background: active ? 'var(--proto-accent-bg)' : 'var(--proto-card)', color: active ? 'var(--proto-accent)' : 'var(--proto-muted)' }}>{children}</button>;
}

function PortsNote({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={{ padding: '10px 12px', color: 'var(--proto-muted-2)', font: `500 10.5px ${MONO}` }}>{children}</div>;
}

function NavBtn({ children, title, disabled, onClick }: { children: React.ReactNode; title: string; disabled?: boolean; onClick: () => void }): JSX.Element {
  return <button type="button" title={title} disabled={disabled} onClick={onClick} style={{ ...SMALL_BUTTON, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}>{children}</button>;
}

const ADDRESS_FIELD_STYLE: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 8px', borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-gray)' };
const ADDRESS_BADGE_STYLE: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none', maxWidth: '45%', height: 16, padding: '0 6px', borderRadius: 5, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)', font: `600 9px ${MONO}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const SMALL_BUTTON: React.CSSProperties = { width: 26, height: 26, flex: 'none', borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-card)', color: 'var(--proto-muted)', font: `500 13px ${MONO}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 };
const SELECT_STYLE: React.CSSProperties = { height: 26, borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-card)', color: 'var(--proto-muted)', font: `500 10.5px ${MONO}`, cursor: 'pointer' };
const PORT_BUTTON: React.CSSProperties = { height: 26, flex: 'none', padding: '0 8px', borderRadius: 7, font: `600 10.5px ${MONO}`, cursor: 'pointer' };
const DEVICE_BUTTON: React.CSSProperties = { height: 22, padding: '0 8px', borderRadius: 6, font: `600 10px ${MONO}`, cursor: 'pointer' };
const PORT_ROW_STYLE: React.CSSProperties = { display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '6px 12px', border: 'none', borderBottom: '1px solid var(--proto-line)', background: 'transparent', color: 'var(--proto-ink)', font: `500 11px ${MONO}`, cursor: 'pointer', textAlign: 'left' };
const NOTICE_STYLE: React.CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-gray)', color: 'var(--proto-muted-2)', font: `500 10.5px ${MONO}` };
const NOTICE_BUTTON: React.CSSProperties = { border: '1px solid var(--proto-line)', borderRadius: 6, background: 'transparent', color: 'var(--proto-accent)', font: `600 10.5px ${MONO}`, padding: '1px 7px', cursor: 'pointer' };
const EMPTY_STYLE: React.CSSProperties = { margin: 'auto', padding: '32px 24px', textAlign: 'center', color: 'var(--proto-muted-2)', font: `500 11.5px ${MONO}`, maxWidth: 320 };
