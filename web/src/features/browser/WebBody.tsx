// input:  browser tabs, frame titles, app origins and port forwarding
// output: sortable live tabs with titles and forward provenance
// pos:    Desktop browser workspace view
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, Reorder, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { apiBase } from '@/lib/desktop-config';
import { useMotionMode, type MotionMode } from '@/theme';
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
  applyBrowserTitle,
  browserItemName,
  browserTabChip,
  browserTabForwardSource,
  browserTabLabel,
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
  reorderBrowserTabs,
  selectBrowserTab,
  updateBrowserTab,
  webItem,
  type BrowserTabChip,
  type BrowserTabState,
  type BrowserTabsState,
  type ViewportPreset,
  type WebItem,
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

/** One browser workspace. Tabs and their iframe documents live until their explicit close action. */
export function WebBody({ item }: { item: WebItem }): JSX.Element {
  const { show } = usePinnedPreview();
  const [tabs, setTabs] = useState<BrowserTabsState>(() => createBrowserTabs('browser-tab-0'));
  const [ports, setPorts] = useState<PortPickerState>(EMPTY_PORTS);
  const nextTab = useRef(1);
  const nextForwardOperation = useRef(1);
  const forwardOperations = useRef(new Map<string, number>());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const frameOrder = useRef(['browser-tab-0']);
  const tabsRef = useRef(tabs);
  const active = activeBrowserTab(tabs);
  const url = currentUrl(active.history);
  const forbiddenOrigins = useMemo(
    () => [typeof window === 'undefined' ? '' : window.location.origin, apiBase()],
    [],
  );

  const updateTab = (id: string, update: (tab: BrowserTabState) => BrowserTabState): void => {
    setTabs((state) => updateBrowserTab(state, id, update));
  };

  const navigate = (raw: string, id = tabsRef.current.activeId): void => {
    const next = normalizeBrowserUrl(raw);
    if (next === null) return updateTab(id, (tab) => rejectNavigation(tab, INVALID_ADDRESS));
    if (previewOriginConflict(next, forbiddenOrigins)) {
      return updateTab(id, (tab) => rejectNavigation(tab, ORIGIN_CONFLICT));
    }
    forwardOperations.current.delete(id);
    updateTab(id, (tab) => navigateTab(tab, next));
    if (id === tabsRef.current.activeId) show(webItem(next));
  };

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    if (item.url === '') return;
    const current = activeBrowserTab(tabsRef.current);
    if (item.url === currentUrl(current.history)) return;
    forwardOperations.current.delete(current.id);
    setTabs((state) => {
      const tab = activeBrowserTab(state);
      if (item.url === currentUrl(tab.history)) return state;
      return updateBrowserTab(state, tab.id, (entry) => navigateTab(entry, item.url));
    });
  }, [item.url]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onMessage = (event: MessageEvent): void => {
      const message = matchFrameTitleMessage(frameRefs.current, event.source, event.data, event.origin);
      if (!message) return;
      updateTab(message.tabId, (tab) => applyBrowserTitle(
        tab, message.title, message.timeOrigin, message.phase,
      ));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (url === null) inputRef.current?.focus();
  }, [tabs.activeId, url]);

  const addTab = (): void => {
    const tab = createBrowserTab(`browser-tab-${nextTab.current++}`);
    setTabs((state) => {
      const next = addBrowserTab(state, tab);
      frameOrder.current = syncFrameOrder(frameOrder.current, next.tabs);
      return next;
    });
    show(webItem(''));
  };

  const pickTab = (id: string): void => {
    const tab = tabs.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    setTabs((state) => selectBrowserTab(state, id));
    show(webItem(currentUrl(tab.history) ?? ''));
  };

  const removeTab = (id: string): void => {
    forwardOperations.current.delete(id);
    const replacement = createBrowserTab(`browser-tab-${nextTab.current++}`);
    const next = closeBrowserTab(tabs, id, replacement);
    frameOrder.current = syncFrameOrder(frameOrder.current, next.tabs);
    setTabs(next);
    if (id === tabs.activeId) show(webItem(currentUrl(activeBrowserTab(next).history) ?? ''));
  };

  const reorderTabs = (orderedIds: string[]): void => {
    setTabs((state) => reorderBrowserTabs(state, orderedIds));
  };

  const step = (dir: 'back' | 'forward'): void => {
    forwardOperations.current.delete(active.id);
    const history = dir === 'back' ? goBack(active.history) : goForward(active.history);
    const target = currentUrl(history);
    updateTab(active.id, (tab) => openDocument(tab, { history, draft: target ?? '' }));
    if (target) show(webItem(target));
  };

  const reload = (): void => {
    forwardOperations.current.delete(active.id);
    updateTab(active.id, (tab) => openDocument(tab, { reloadNonce: tab.reloadNonce + 1 }));
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
    const tabId = tabsRef.current.activeId;
    const device = ports.device;
    const operationId = nextForwardOperation.current++;
    forwardOperations.current.set(tabId, operationId);
    setPorts((state) => ({ ...state, open: false }));
    updateTab(tabId, (tab) => ({
      ...tab,
      pageTitle: null,
      forward: { status: 'connecting', operationId, device, originalPort: port },
      rejected: null,
    }));
    try {
      const serverPort = device === '' ? port : (await openDeviceForward(device, port)).localPort;
      if (forwardOperations.current.get(tabId) !== operationId) return;
      const rawTarget = canForward() ? (await startForward(serverPort)).url : `http://127.0.0.1:${serverPort}/`;
      if (forwardOperations.current.get(tabId) !== operationId) return;
      const target = normalizeBrowserUrl(rawTarget);
      if (!target) throw new Error(INVALID_ADDRESS);
      if (previewOriginConflict(target, forbiddenOrigins)) throw new Error(ORIGIN_CONFLICT);
      forwardOperations.current.delete(tabId);
      updateTab(tabId, (tab) => completeForward(tab, operationId, device, port, target));
      if (tabId === tabsRef.current.activeId) show(webItem(target));
    } catch (error) {
      if (forwardOperations.current.get(tabId) !== operationId) return;
      forwardOperations.current.delete(tabId);
      updateTab(tabId, (tab) => failForward(tab, operationId, (error as Error).message));
    }
  };

  return (
    <div data-browser-workspace="" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TabStrip state={tabs} onAdd={addTab} onSelect={pickTab} onClose={removeTab} onReorder={reorderTabs} />
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
      <BrowserFrames state={tabs} order={frameOrder.current} frameRefs={frameRefs.current} onLoad={onFrameLoad} />
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

function TabStrip({ state, onAdd, onSelect, onClose, onReorder }: {
  state: BrowserTabsState;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
}): JSX.Element {
  const motionMode = useMotionMode();
  const systemReduced = useReducedMotion();
  const reduceMotion = motionMode === 'reduced' || (motionMode === 'system' && systemReduced === true);
  return (
    <MotionConfig reducedMotion={motionReduction(motionMode)}>
      <Reorder.Group as="div" axis="x" values={state.tabs.map((tab) => tab.id)} onReorder={onReorder} layoutScroll style={TAB_STRIP_STYLE}>
        <AnimatePresence initial={false} mode="popLayout">
          {state.tabs.map((tab) => <BrowserTab key={tab.id} tab={tab} active={tab.id === state.activeId} draggable={state.tabs.length > 1} reduceMotion={reduceMotion} onSelect={onSelect} onClose={onClose} />)}
        </AnimatePresence>
        <motion.button layout type="button" data-add-tab="" title="New tab" onClick={onAdd} style={{ ...SMALL_BUTTON, alignSelf: 'flex-end', borderRadius: '7px 7px 0 0' }}>+</motion.button>
      </Reorder.Group>
    </MotionConfig>
  );
}

interface BrowserTabProps {
  tab: BrowserTabState;
  active: boolean;
  draggable: boolean;
  reduceMotion: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

const BrowserTab = forwardRef<HTMLDivElement, BrowserTabProps>(function BrowserTab(
  { tab, active, draggable, reduceMotion, onSelect, onClose }, ref,
): JSX.Element {
  const url = currentUrl(tab.history);
  const label = browserTabLabel(tab);
  const source = browserTabForwardSource(tab);
  const chip = browserTabChip(tab);
  const tooltip = source ? `${label}\nForwarded from ${source}` : (url ?? label);
  const isPresent = useIsPresent();
  return (
    <Reorder.Item ref={ref} as="div" value={tab.id} dragListener={draggable && isPresent} dragElastic={0.08} initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }} animate={reduceMotion ? undefined : { opacity: 1, scale: 1 }} exit={reduceMotion ? undefined : { opacity: 0, scale: 0.94, transition: { duration: 0.12, ease: 'easeIn' } }} transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40, opacity: { duration: 0.12 }, scale: { duration: 0.14 } }} whileDrag={reduceMotion ? undefined : { scale: 1.03 }} style={{ ...TAB_ITEM_STYLE, pointerEvents: isPresent ? 'auto' : 'none', borderBottomColor: active ? 'var(--proto-card)' : 'var(--proto-line)', background: active ? 'var(--proto-card)' : 'var(--proto-gray)' }}>
      <button type="button" aria-pressed={active} data-browser-tab={tab.id} data-active={active ? 'true' : 'false'} onClick={() => onSelect(tab.id)} title={tooltip} style={{ ...TAB_SELECT_STYLE, color: active ? 'var(--proto-ink)' : 'var(--proto-muted)' }}>
        {chip && <TabChip chip={chip} source={source} />}
        <span style={TAB_LABEL_STYLE}>{label}</span>
      </button>
      <button type="button" disabled={!isPresent} data-close-tab={tab.id} title="Close tab" aria-label="Close tab" onPointerDown={(event) => event.stopPropagation()} onClick={() => onClose(tab.id)} style={TAB_CLOSE_STYLE}>×</button>
    </Reorder.Item>
  );
});

/** The forward chip keeps `data-forward-source` — provenance the address bar cannot show. */
function TabChip({ chip, source }: { chip: BrowserTabChip; source: string | null }): JSX.Element {
  const forwarded = chip.kind === 'forward' && source !== null;
  return (
    <span
      {...(forwarded ? { 'data-forward-source': source } : {})}
      title={forwarded ? `Forwarded from ${source}` : undefined}
      style={forwarded ? TAB_CHIP_FORWARD_STYLE : TAB_CHIP_PLAIN_STYLE}
    >{chip.text}</span>
  );
}

function motionReduction(mode: MotionMode): 'always' | 'never' | 'user' {
  if (mode === 'reduced') return 'always';
  if (mode === 'full') return 'never';
  return 'user';
}

function syncFrameOrder(current: string[], tabs: BrowserTabState[]): string[] {
  const liveIds = new Set(tabs.map((tab) => tab.id));
  const kept = current.filter((id) => liveIds.has(id));
  const known = new Set(kept);
  return [...kept, ...tabs.map((tab) => tab.id).filter((id) => !known.has(id))];
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

function BrowserFrames({ state, order, frameRefs, onLoad }: {
  state: BrowserTabsState;
  order: string[];
  frameRefs: Map<string, HTMLIFrameElement>;
  onLoad: (id: string) => void;
}): JSX.Element {
  const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const renderTabs = order.map((id) => tabsById.get(id)).filter((tab): tab is BrowserTabState => tab !== undefined);
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--proto-gray)', position: 'relative' }}>
      {renderTabs.map((tab) => {
        const active = tab.id === state.activeId;
        const url = currentUrl(tab.history);
        const viewport = VIEWPORT_PRESETS.find((preset) => preset.id === tab.viewportId) ?? VIEWPORT_PRESETS[0];
        return (
          <div key={tab.id} data-browser-tab-body={tab.id} style={{ display: active ? 'flex' : 'none', position: 'absolute', inset: 0, overflow: 'auto', justifyContent: 'center' }}>
            {url === null ? <div style={EMPTY_STYLE}>{EMPTY_HINT}</div> : (
              <iframe
                key={`${tab.documentGeneration}:${tab.reloadNonce}`}
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

const TAB_STRIP_STYLE: React.CSSProperties = { display: 'flex', gap: 3, padding: '5px 7px 0', background: 'var(--proto-gray)', overflowX: 'auto', flex: 'none', position: 'relative' };
const TAB_ITEM_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', flex: 'none', minWidth: 96, maxWidth: 210, height: 30, border: '1px solid var(--proto-line)', borderRadius: '7px 7px 0 0', position: 'relative', cursor: 'grab', overflow: 'hidden', transition: 'background-color 140ms ease, border-color 140ms ease' };
const TAB_SELECT_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', minWidth: 0, height: '100%', flex: 1, padding: '0 2px 0 7px', border: 'none', background: 'transparent', font: `500 10px ${MONO}`, cursor: 'inherit', transition: 'color 140ms ease', textAlign: 'left' };
const TAB_LABEL_STYLE: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '13px' };
const TAB_CHIP_STYLE: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', flex: 'none', maxWidth: 98, height: 16, padding: '0 5px', marginRight: 6, borderRadius: 5, font: `600 9px ${MONO}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const TAB_CHIP_FORWARD_STYLE: React.CSSProperties = { ...TAB_CHIP_STYLE, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' };
const TAB_CHIP_PLAIN_STYLE: React.CSSProperties = { ...TAB_CHIP_STYLE, border: '1px solid var(--proto-line)', color: 'var(--proto-muted-2)' };
const ADDRESS_FIELD_STYLE: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 8px', borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-gray)' };
const ADDRESS_BADGE_STYLE: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none', maxWidth: '45%', height: 16, padding: '0 6px', borderRadius: 5, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)', font: `600 9px ${MONO}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const TAB_CLOSE_STYLE: React.CSSProperties = { width: 24, height: '100%', flex: 'none', border: 'none', background: 'transparent', color: 'var(--proto-muted-2)', font: `500 13px ${MONO}`, lineHeight: 1, cursor: 'pointer', padding: 0 };
const SMALL_BUTTON: React.CSSProperties = { width: 26, height: 26, flex: 'none', borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-card)', color: 'var(--proto-muted)', font: `500 13px ${MONO}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 };
const SELECT_STYLE: React.CSSProperties = { height: 26, borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-card)', color: 'var(--proto-muted)', font: `500 10.5px ${MONO}`, cursor: 'pointer' };
const PORT_BUTTON: React.CSSProperties = { height: 26, flex: 'none', padding: '0 8px', borderRadius: 7, font: `600 10.5px ${MONO}`, cursor: 'pointer' };
const DEVICE_BUTTON: React.CSSProperties = { height: 22, padding: '0 8px', borderRadius: 6, font: `600 10px ${MONO}`, cursor: 'pointer' };
const PORT_ROW_STYLE: React.CSSProperties = { display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '6px 12px', border: 'none', borderBottom: '1px solid var(--proto-line)', background: 'transparent', color: 'var(--proto-ink)', font: `500 11px ${MONO}`, cursor: 'pointer', textAlign: 'left' };
const NOTICE_STYLE: React.CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-gray)', color: 'var(--proto-muted-2)', font: `500 10.5px ${MONO}` };
const NOTICE_BUTTON: React.CSSProperties = { border: '1px solid var(--proto-line)', borderRadius: 6, background: 'transparent', color: 'var(--proto-accent)', font: `600 10.5px ${MONO}`, padding: '1px 7px', cursor: 'pointer' };
const EMPTY_STYLE: React.CSSProperties = { margin: 'auto', padding: '32px 24px', textAlign: 'center', color: 'var(--proto-muted-2)', font: `500 11.5px ${MONO}`, maxWidth: 320 };
