// input:  current browser opt-in for a draft session
// output: a composer chip that turns browser control on for the session about to be created
// pos:    Session-creation surface for the managed browser
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useState, type CSSProperties } from 'react';
import { useVocab } from '@/i18n';

/** The only device that can host the browser today. When the cortex-client reverse channel lands,
 *  this becomes a picker over connected devices (plan/embedded-browser.md §17.4, §18). */
export const DEFAULT_BROWSER_DEVICE = 'server';

function chipStyle(active: boolean, hover: boolean): CSSProperties {
  return {
    font: "500 10.5px 'IBM Plex Mono',monospace",
    border: `1px solid ${active || hover ? 'var(--proto-accent-border)' : 'var(--proto-line)'}`,
    color: active || hover ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
    background: active ? 'var(--proto-accent-bg)' : 'transparent',
    padding: '2px 7px',
    borderRadius: 6,
    cursor: 'pointer',
  };
}

/**
 * Browser control is opt-in per session because it costs ~24 tools of context that a session which
 * never browses should not carry. It can only be chosen BEFORE the session exists: the tool set is
 * fixed when the agent process spawns.
 */
export function BrowserOptInChip({ device, onChange }: {
  device: string | null;
  /** Omitted for a session that already exists: the chip then only REPORTS what it was created
   *  with. Offering a control there would promise a change the running process cannot make. */
  onChange?: (device: string | null) => void;
}): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState(false);
  const active = device !== null;
  const editable = typeof onChange === 'function';
  return (
    <span
      data-chip="browser"
      data-active={active ? 'true' : 'false'}
      data-editable={editable ? 'true' : 'false'}
      title={editable ? (active ? L.wbBrowserOn : L.wbBrowserOff) : L.wbBrowserFixed}
      onClick={editable ? () => onChange!(active ? null : DEFAULT_BROWSER_DEVICE) : undefined}
      onMouseEnter={() => { if (editable) setHover(true); }}
      onMouseLeave={() => setHover(false)}
      style={{ ...chipStyle(active, hover), cursor: editable ? 'pointer' : 'default' }}
    >
      {active ? `${L.wbBrowser} · ${device}` : L.wbBrowser}
    </span>
  );
}
