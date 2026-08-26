// input:  browser tab state, app/API origins and port forwarding
// output: tabbed browser pane with live iframe keep-alive
// pos:    Desktop browser workspace view
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiBase } from '@/lib/desktop-config';
import { openExternalUrl } from '@/lib/external-navigation';
import { usePinnedPreview } from '@/features/media/PinnedPreviewProvider';
import {
  canForward, listDeviceRemotePorts, listForwardDevices, listRemotePorts, openDeviceForward,
  startForward, type ForwardDevice, type ListeningPort,
} from './forward';
import {
  FRAME_REFUSED_HINT,
  VIEWPORT_PRESETS,
  WEB_SANDBOX,
  activeBrowserTab,
  addBrowserTab,
  browserItemName,
  canGoBack,
  canGoForward,
  closeBrowserTab,
  createBrowserTab,
  createBrowserTabs,
  currentUrl,
  frameRefusedEmbedding,
  goBack,
  goForward,
  normalizeBrowserUrl,
  previewOriginConflict,
  pushHistory,
  selectBrowserTab,
  updateBrowserTab,
  webItem,
  type BrowserTabState,
  type BrowserTabsState,
  type ViewportPreset,
  type WebItem,
} from './browser-target';

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

/** One browser workspace. Tabs and their iframe documents live until their explicit close action. */
export function WebBody({ item }: { item: WebItem }): JSX.Element {
  const { show } = usePinnedPreview();
  const [tabs, setTabs] = useState<BrowserTabsState>(() => createBrowserTabs('browser-tab-0'));
  const [ports, setPorts] = useState<PortPickerState>(EMPTY_PORTS);
  const nextTab = useRef(1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const active = activeBrowserTab(tabs);
  const url = currentUrl(active.history);
  const forbiddenOrigins = useMemo(
    () => [typeof window === 'undefined' ? '' : window.location.origin, apiBase()],
    [],
  );

  const updateTab = (id: string, update: (tab: BrowserTabState) => BrowserTabState): void => {
    setTabs((state) => updateBrowserTab(state, id, update));
  };

  const navigate = (raw: string, id = tabs.activeId): void => {
    const next = normalizeBrowserUrl(raw);
    if (next === null) return updateTab(id, (tab) => ({ ...tab, rejected: INVALID_ADDRESS }));
    if (previewOriginConflict(next, forbiddenOrigins)) {
      return updateTab(id, (tab) => ({ ...tab, rejected: ORIGIN_CONFLICT }));
    }
    updateTab(id, (tab) => ({
      ...tab,
      history: pushHistory(tab.history, next),
      draft: next,
      rejected: null,
      refused: false,
    }));
    if (id === tabs.activeId) show(webItem(next));
  };

  useEffect(() => {
    if (item.url === '') return;
    setTabs((state) => {
      const tab = activeBrowserTab(state);
      if (item.url === currentUrl(tab.history)) return state;
      return updateBrowserTab(state, tab.id, (current) => ({
        ...current,
        history: pushHistory(current.history, item.url),
        draft: item.url,
        rejected: null,
        refused: false,
      }));
    });
  }, [item.url]);

  useEffect(() => {
    if (url === null) inputRef.current?.focus();
  }, [tabs.activeId, url]);

  const addTab = (): void => {
    const tab = createBrowserTab(`browser-tab-${nextTab.current++}`);
    setTabs((state) => addBrowserTab(state, tab));
    show(webItem(''));
  };

  const pickTab = (id: string): void => {
    const tab = tabs.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    setTabs((state) => selectBrowserTab(state, id));
    show(webItem(currentUrl(tab.history) ?? ''));
  };

  const removeTab = (id: string): void => {
    const replacement = createBrowserTab(`browser-tab-${nextTab.current++}`);
    const next = closeBrowserTab(tabs, id, replacement);
    setTabs(next);
    if (id === tabs.activeId) show(webItem(currentUrl(activeBrowserTab(next).history) ?? ''));
  };

  const step = (dir: 'back' | 'forward'): void => {
    const history = dir === 'back' ? goBack(active.history) : goForward(active.history);
    const target = currentUrl(history);
    updateTab(active.id, (tab) => ({ ...tab, history, draft: target ?? '', refused: false }));
    if (target) show(webItem(target));
  };

  const reload = (): void => {
    updateTab(active.id, (tab) => ({ ...tab, reloadNonce: tab.reloadNonce + 1, refused: false }));
  };

  const onFrameLoad = (id: string): void => {
    let reachable = false;
    try {
      reachable = !!frameRefs.current.get(id)?.contentDocument;
    } catch {
      reachable = false;
    }
    const refused = frameRefusedEmbedding({ loaded: true, documentReachable: reachable });
    updateTab(id, (tab) => ({ ...tab, refused }));
  };

  const loadPorts = (device: string): void => {
    setPorts((state) => ({ ...state, ports: null, error: null }));
    const request = device === '' ? listRemotePorts() : listDeviceRemotePorts(device);
    request
      .then((next) => setPorts((state) => ({ ...state, ports: next })))
      .catch((error: Error) => setPorts((state) => ({ ...state, error: error.message })));
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
    setPorts((state) => ({ ...state, open: false }));
    try {
      const serverPort = ports.device === '' ? port : (await openDeviceForward(ports.device, port)).localPort;
      const target = canForward() ? (await startForward(serverPort)).url : `http://127.0.0.1:${serverPort}/`;
      navigate(target);
    } catch (error) {
      updateTab(active.id, (tab) => ({ ...tab, rejected: (error as Error).message }));
    }
  };

  return (
    <div data-browser-workspace="" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TabStrip state={tabs} onAdd={addTab} onSelect={pickTab} onClose={removeTab} />
      <BrowserToolbar
        tab={active}
        url={url}
        inputRef={inputRef}
        portsOpen={ports.open}
        onStep={step}
        onReload={reload}
        onDraft={(draft) => updateTab(active.id, (tab) => ({ ...tab, draft }))}
        onNavigate={() => navigate(active.draft)}
        onResetDraft={() => updateTab(active.id, (tab) => ({ ...tab, draft: url ?? '' }))}
        onViewport={(viewportId) => updateTab(active.id, (tab) => ({ ...tab, viewportId }))}
        onTogglePorts={togglePorts}
      />
      {ports.open && <PortsPanel state={ports} onDevice={pickDevice} onPort={openPort} />}
      <BrowserNotice tab={active} url={url} />
      <BrowserFrames state={tabs} frameRefs={frameRefs.current} onLoad={onFrameLoad} />
    </div>
  );
}

function TabStrip({ state, onAdd, onSelect, onClose }: {
  state: BrowserTabsState;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 3, padding: '5px 7px 0', background: 'var(--proto-gray)', overflowX: 'auto', flex: 'none' }}>
      {state.tabs.map((tab) => {
        const active = tab.id === state.activeId;
        const url = currentUrl(tab.history);
        return (
          <button
            key={tab.id}
            type="button"
            data-browser-tab={tab.id}
            data-active={active ? 'true' : 'false'}
            onClick={() => onSelect(tab.id)}
            title={url ?? 'New tab'}
            style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 92, maxWidth: 180, height: 27, padding: '0 7px', border: '1px solid var(--proto-line)', borderBottomColor: active ? 'var(--proto-card)' : 'var(--proto-line)', borderRadius: '7px 7px 0 0', background: active ? 'var(--proto-card)' : 'var(--proto-gray)', color: active ? 'var(--proto-ink)' : 'var(--proto-muted)', font: `500 10px ${MONO}`, cursor: 'pointer' }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{url ? browserItemName(url) : 'New tab'}</span>
            <span
              role="button"
              data-close-tab={tab.id}
              title="Close tab"
              onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
              style={{ color: 'var(--proto-muted-2)', fontSize: 13, lineHeight: 1 }}
            >×</span>
          </button>
        );
      })}
      <button type="button" data-add-tab="" title="New tab" onClick={onAdd} style={{ ...SMALL_BUTTON, borderRadius: '7px 7px 0 0' }}>+</button>
    </div>
  );
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
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-card)' }}>
      <NavBtn title="Back" disabled={!canGoBack(tab.history)} onClick={() => onStep('back')}>‹</NavBtn>
      <NavBtn title="Forward" disabled={!canGoForward(tab.history)} onClick={() => onStep('forward')}>›</NavBtn>
      <NavBtn title="Reload" disabled={url === null} onClick={onReload}>⟳</NavBtn>
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
        style={{ flex: 1, minWidth: 0, height: 26, padding: '0 8px', borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-gray)', color: 'var(--proto-ink)', font: `500 11px ${MONO}`, outline: 'none' }}
      />
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

function BrowserFrames({ state, frameRefs, onLoad }: {
  state: BrowserTabsState;
  frameRefs: Map<string, HTMLIFrameElement>;
  onLoad: (id: string) => void;
}): JSX.Element {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--proto-gray)', position: 'relative' }}>
      {state.tabs.map((tab) => {
        const active = tab.id === state.activeId;
        const url = currentUrl(tab.history);
        const viewport = VIEWPORT_PRESETS.find((preset) => preset.id === tab.viewportId) ?? VIEWPORT_PRESETS[0];
        return (
          <div key={tab.id} data-browser-tab-body={tab.id} style={{ display: active ? 'flex' : 'none', position: 'absolute', inset: 0, overflow: 'auto', justifyContent: 'center' }}>
            {url === null ? <div style={EMPTY_STYLE}>{EMPTY_HINT}</div> : (
              <iframe
                key={tab.reloadNonce}
                ref={(node) => { if (node) frameRefs.set(tab.id, node); else frameRefs.delete(tab.id); }}
                data-browser-frame={tab.id}
                onLoad={() => onLoad(tab.id)}
                src={url}
                title={browserItemName(url)}
                sandbox={WEB_SANDBOX}
                style={{ border: 'none', width: viewport.width ?? '100%', flex: viewport.width ? 'none' : 1, minHeight: '100%', background: 'var(--proto-card)' }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function PortRow({ port, onClick }: { port: ListeningPort; onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} style={PORT_ROW_STYLE}>
      <span style={{ fontWeight: 600 }}>{port.port}</span>
      <span style={{ color: 'var(--proto-muted-2)' }}>{port.process ?? '—'}</span>
      <span style={{ marginLeft: 'auto', color: 'var(--proto-faint)' }}>{port.address}</span>
    </button>
  );
}

function DeviceTab({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }): JSX.Element {
  return <button type="button" onClick={onClick} style={{ ...DEVICE_BUTTON, border: active ? '1.5px solid var(--proto-accent)' : '1px solid var(--proto-line)', background: active ? 'var(--proto-accent-bg)' : 'transparent', color: active ? 'var(--proto-accent)' : 'var(--proto-muted)' }}>{children}</button>;
}

function PortsNote({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={{ padding: '8px 12px', color: 'var(--proto-muted-2)', font: `500 10.5px ${MONO}` }}>{children}</div>;
}

function NavBtn({ children, title, disabled, onClick }: { children: React.ReactNode; title: string; disabled?: boolean; onClick: () => void }): JSX.Element {
  return <button type="button" title={title} disabled={disabled} onClick={onClick} style={{ ...SMALL_BUTTON, color: disabled ? 'var(--proto-faint)' : 'var(--proto-muted)', cursor: disabled ? 'default' : 'pointer' }}>{children}</button>;
}

const SMALL_BUTTON: React.CSSProperties = { width: 26, height: 26, flex: 'none', borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-card)', color: 'var(--proto-muted)', font: `500 13px ${MONO}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 };
const SELECT_STYLE: React.CSSProperties = { height: 26, borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-card)', color: 'var(--proto-muted)', font: `500 10.5px ${MONO}`, cursor: 'pointer' };
const PORT_BUTTON: React.CSSProperties = { height: 26, flex: 'none', padding: '0 8px', borderRadius: 7, font: `600 10.5px ${MONO}`, cursor: 'pointer' };
const DEVICE_BUTTON: React.CSSProperties = { height: 22, padding: '0 8px', borderRadius: 6, font: `600 10px ${MONO}`, cursor: 'pointer' };
const PORT_ROW_STYLE: React.CSSProperties = { display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '6px 12px', border: 'none', borderBottom: '1px solid var(--proto-line)', background: 'transparent', color: 'var(--proto-ink)', font: `500 11px ${MONO}`, cursor: 'pointer', textAlign: 'left' };
const NOTICE_STYLE: React.CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-gray)', color: 'var(--proto-muted-2)', font: `500 10.5px ${MONO}` };
const NOTICE_BUTTON: React.CSSProperties = { border: '1px solid var(--proto-line)', borderRadius: 6, background: 'transparent', color: 'var(--proto-accent)', font: `600 10.5px ${MONO}`, padding: '1px 7px', cursor: 'pointer' };
const EMPTY_STYLE: React.CSSProperties = { margin: 'auto', padding: '32px 24px', textAlign: 'center', color: 'var(--proto-muted-2)', font: `500 11.5px ${MONO}`, maxWidth: 320 };
