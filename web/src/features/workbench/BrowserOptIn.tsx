// input:  current browser opt-in for a draft session, and the connected devices
// output: a composer chip that picks which machine's browser the session will drive
// pos:    Session-creation surface for the managed browser
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { listForwardDevices, type ForwardDevice } from '@/features/browser/forward';
import { fetchBrowserStatus, takeoverHint, type BrowserStatus } from './browser-status';

/** This host's own Chrome. Any other value names a device, whose Chrome is launched by its
 *  cortex-client and reached through the reverse channel (plan/embedded-browser.md §18). */
export const DEFAULT_BROWSER_DEVICE = 'server';

const MONO = "'IBM Plex Mono',monospace";

function chipStyle(active: boolean, hover: boolean): CSSProperties {
  return {
    position: 'relative',
    font: `500 10.5px ${MONO}`,
    border: `1px solid ${active || hover ? 'var(--proto-accent-border)' : 'var(--proto-line)'}`,
    color: active || hover ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
    background: active ? 'var(--proto-accent-bg)' : 'transparent',
    padding: '2px 7px',
    borderRadius: 6,
    cursor: 'pointer',
  };
}

/** Escape and outside-click dismissal, matching the profile chip's menu. */
function useDismissMenu(open: boolean, close: () => void): void {
  useEffect(() => {
    // No window under SSR or a node test environment; the menu simply keeps no global listeners.
    if (!open || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', close);
    };
  }, [open, close]);
}

interface DeviceOption {
  /** null is the "off" row. */
  device: string | null;
  label: string;
  sub: string;
}

/**
 * Browser control is opt-in per session because it costs ~24 tools of context that a session which
 * never browses should not carry. It can only be chosen BEFORE the session exists: the tool set is
 * fixed when the agent process spawns.
 *
 * The device matters as much as the switch. A browser on the server draws on the server's display;
 * a browser on your laptop opens a window on the screen in front of you, and inherits the logins
 * already in that profile — which is usually the reason to want one.
 */
export function BrowserOptInChip({ device, onChange }: {
  device: string | null;
  /** Omitted for a session that already exists: the chip then only REPORTS what it was created
   *  with. Offering a control there would promise a change the running process cannot make. */
  onChange?: (device: string | null) => void;
}): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<ForwardDevice[]>([]);
  const active = device !== null;
  const editable = typeof onChange === 'function';
  const close = useCallback(() => setOpen(false), []);
  useDismissMenu(open, close);

  // Only a live browser session asks the server where its browser is — a draft has none yet, and a
  // session without browser access has nothing to take over.
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  useEffect(() => {
    if (editable || !active) return;
    let alive = true;
    fetchBrowserStatus().then((s) => { if (alive) setStatus(s); }).catch(() => { /* tooltip stays basic */ });
    return () => { alive = false; };
  }, [editable, active]);

  // Devices come and go; the list is read when the menu opens rather than held, so it cannot offer
  // a machine that has since disconnected.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    listForwardDevices().then((d) => { if (alive) setDevices(d); }).catch(() => { if (alive) setDevices([]); });
    return () => { alive = false; };
  }, [open]);

  const hint = status
    ? takeoverHint(status, {
        attached: L.wbBrowserAttached, virtual: L.wbBrowserVirtual, headless: L.wbBrowserHeadless,
        running: L.wbBrowserRunning, stopped: L.wbBrowserStopped,
      })
    : null;

  const options: DeviceOption[] = [
    { device: null, label: L.wbBrowserOffOption, sub: '' },
    { device: DEFAULT_BROWSER_DEVICE, label: DEFAULT_BROWSER_DEVICE, sub: L.wbBrowserThisHost },
    ...devices.map((d) => ({ device: d.device, label: d.device, sub: d.platform })),
  ];

  return (
    <span
      data-chip="browser"
      data-active={active ? 'true' : 'false'}
      data-editable={editable ? 'true' : 'false'}
      title={editable
        ? (active ? L.wbBrowserOn : L.wbBrowserOff)
        : hint ? `${L.wbBrowserFixed}\n${hint}` : L.wbBrowserFixed}
      onClick={editable ? (e) => { e.stopPropagation(); setOpen((o) => !o); } : undefined}
      onMouseEnter={() => { if (editable) setHover(true); }}
      onMouseLeave={() => setHover(false)}
      style={{ ...chipStyle(active, hover), cursor: editable ? 'pointer' : 'default' }}
    >
      {active ? `${L.wbBrowser} · ${device}` : L.wbBrowser}
      {editable && <span style={{ marginLeft: 4, fontSize: 7.5, color: 'var(--proto-muted)' }}>▾</span>}
      {open && editable && (
        <span
          data-menu="browser"
          style={{
            position: 'absolute', left: 0, bottom: 26,
            background: 'var(--proto-card)', border: '1px solid var(--proto-line)',
            borderRadius: 8, boxShadow: 'var(--shadow-menu)', zIndex: 59,
            overflow: 'hidden', minWidth: 150, display: 'block',
          }}
        >
          {options.map((o) => (
            <span
              key={o.device ?? '__off__'}
              data-device={o.device ?? '__off__'}
              onClick={(e) => { e.stopPropagation(); close(); onChange!(o.device); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', cursor: 'pointer',
                background: o.device === device ? 'var(--proto-accent-bg)' : 'transparent',
              }}
            >
              <span style={{ font: `600 10px ${MONO}`, color: 'var(--proto-ink)' }}>{o.label}</span>
              <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-muted-3)' }}>{o.sub}</span>
              {o.device === device && (
                <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 9, fontWeight: 700 }}>✓</span>
              )}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
