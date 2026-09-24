// input:  BrowserTabState, forwarding ports and devices
// output: PortsPanel, BrowserNotice, BrowserEmpty, PortPickerState
// pos:    Browser port picker, empty state and accessible notices
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import type { ReactNode } from 'react';
import { openExternalUrl } from '@/lib/external-navigation';
import { FRAME_REFUSED_HINT, type BrowserTabState } from './browser-target';
import { canForward, type ForwardDevice, type ListeningPort } from './forward';

export interface PortPickerState {
  open: boolean;
  ports: ListeningPort[] | null;
  error: string | null;
  device: string;
  devices: ForwardDevice[];
}

interface PortsProps {
  state: PortPickerState;
  onDevice: (device: string) => void;
  onPort: (port: number) => Promise<void>;
}

export function PortsPanel({ id, state, onDevice, onPort }: PortsProps & { id: string }): JSX.Element {
  return (
    <section id={id} className="browser-ports" aria-label="Listening ports">
      {state.devices.length > 0 && (
        <div className="browser-devices" role="group" aria-label="Port source">
          <DeviceButton active={state.device === ''} onClick={() => onDevice('')}>server</DeviceButton>
          {state.devices.map((device) => <DeviceButton key={device.device} active={state.device === device.device}
            onClick={() => onDevice(device.device)}>{device.device}</DeviceButton>)}
        </div>
      )}
      <PortsList state={state} onPort={onPort} />
      {!canForward() && <PortsNote>Forwarding needs the desktop app — these open as plain localhost here.</PortsNote>}
    </section>
  );
}

function PortsList({ state, onPort }: Pick<PortsProps, 'state' | 'onPort'>): JSX.Element {
  if (state.error) return <PortsNote error>{state.error}</PortsNote>;
  if (state.ports === null) return <PortsNote>Loading…</PortsNote>;
  if (state.ports.length === 0) return <PortsNote>Nothing is listening on {state.device === '' ? 'the server’s' : `${state.device}’s`} loopback.</PortsNote>;
  return <>{state.ports.map((port) => <PortRow key={`${state.device}:${port.port}`} port={port} onClick={() => void onPort(port.port)} />)}</>;
}

export function BrowserNotice({ tab, url }: { tab: BrowserTabState; url: string | null }): JSX.Element | null {
  if (tab.refused && url) {
    return (
      <div className="browser-notice" role="status">
        <span>{FRAME_REFUSED_HINT}</span>
        <button type="button" className="browser-control browser-icon" data-action="open-external"
          title="Open in system browser" aria-label="Open in system browser" onClick={() => void openExternalUrl(url)}>↗</button>
      </div>
    );
  }
  if (!tab.rejected) return null;
  return <div className="browser-notice browser-error" role="alert">{tab.rejected}</div>;
}

function PortRow({ port, onClick }: { port: ListeningPort; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="browser-control browser-port-row" onClick={onClick}>
      <span className="browser-port-number">{port.port}</span>
      <span className="browser-port-process" title={port.process ?? ''}>{port.process ?? ''}</span>
      <span className="browser-port-address">{port.address}</span>
    </button>
  );
}

function DeviceButton({ children, active, onClick }: { children: ReactNode; active: boolean; onClick: () => void }): JSX.Element {
  return <button type="button" className="browser-control browser-device" aria-pressed={active} onClick={onClick}>{children}</button>;
}

function PortsNote({ children, error }: { children: ReactNode; error?: boolean }): JSX.Element {
  return <div className={`browser-ports-note${error ? ' browser-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>;
}

export function BrowserEmpty(): JSX.Element {
  return (
    <div className="browser-empty">
      <span className="browser-empty-icon" aria-hidden="true">↗</span>
      <strong>Preview a page</strong>
      <p>Enter a port or a URL. Remote dev servers appear here once forwarded.</p>
    </div>
  );
}
