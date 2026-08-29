// input:  ＋ menu actions, browser and commission controls, profile/context/send nodes
// output: Desktop composer toolbar row (＋ menu · mode capsules left, send cluster right) and slash menu
// pos:    Groups composer shortcuts and controls under the input
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { PlusGlyph } from '@/design';
import { useVocab } from '@/i18n';
import type { SlashSuggestion } from './composer-slash';
import { useBrowserDeviceOptions, type BrowserDeviceOption } from './BrowserOptIn';
import { useCommissionOptions, type CommissionOption } from './CommissionOptIn';

const MONO = "'IBM Plex Mono',monospace";

export function ComposerSlashMenu({ suggestions, onPick }: {
  suggestions: SlashSuggestion[];
  onPick: (suggestion: SlashSuggestion) => void;
}): JSX.Element | null {
  const L = useVocab();
  const [hovered, setHovered] = useState<number | null>(null);
  if (suggestions.length === 0) return null;
  return (
    <div data-menu="slash" style={{ position: 'absolute', left: 32, right: 32, bottom: '100%', marginBottom: -2, border: '1px solid var(--proto-line)', borderRadius: 12, boxShadow: 'var(--shadow-menu-soft)', background: 'var(--proto-card)', overflow: 'hidden', zIndex: 10 }}>
      {suggestions.map((suggestion, index) => (
        <div
          key={suggestion.command}
          data-slash-command={suggestion.command}
          onMouseEnter={() => setHovered(index)}
          onMouseLeave={() => setHovered((value) => value === index ? null : value)}
          onClick={() => { if (!suggestion.disabled) onPick(suggestion); }}
          style={{ display: 'flex', alignItems: 'center', padding: '8px 14px', opacity: suggestion.disabled ? 0.45 : 1, background: hovered === index || index === 0 ? 'var(--proto-accent-bg)' : 'var(--proto-card)', cursor: suggestion.disabled ? 'default' : 'pointer' }}
        >
          <span style={{ font: `600 12px ${MONO}`, color: index === 0 ? 'var(--proto-accent)' : 'var(--proto-muted)' }}>{suggestion.command}</span>
          <span style={{ fontSize: 11.5, color: 'var(--proto-muted-2)', marginLeft: 12 }}>{suggestion.description}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', padding: '7px 14px', borderTop: '1px solid var(--proto-alt)', background: 'var(--proto-rail)' }}>
        <span style={{ font: `400 10px ${MONO}`, color: 'var(--proto-faint)' }}>↑↓ {L.wbNavigate} · ⏎ {L.wbRun} · {L.wbEscDismiss}</span>
      </div>
    </div>
  );
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

export interface ComposerBrowserControl {
  device: string | null;
  /** Present only while composing a draft — the tool set is fixed when the agent process spawns.
   *  Absent on a live session: the menu row then only REPORTS what the session was created with. */
  onChange?: (device: string | null) => void;
}

/** Commission mode, chosen the same way and for the same reason as the browser: it decides which
 *  plan tools and which skill the agent process spawns with, so it is fixed once the session exists.
 *  `value` is null (off), 'new' (drill a contract) or a commission id; `label` is what the capsule
 *  shows on a live session, where the id alone would say nothing. */
export interface ComposerCommissionControl {
  value: null | 'new' | string;
  label?: string | null;
  /** Present only while composing a draft; absent means the capsule only REPORTS. */
  onChange?: (value: null | 'new' | string) => void;
}

const MENU_ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, minHeight: 32, padding: '0 13px',
  cursor: 'pointer', fontSize: 12, color: 'var(--proto-ink)',
};

/** Row glyphs for the ＋ menu — same 16-unit line-art family the mobile attach menu uses, so the
 *  two surfaces read as one menu. Muted stroke: the label carries the row, the icon only anchors it. */
function MenuIcon({ kind, size = 14, color = 'var(--proto-muted-2)' }: {
  kind: 'attach' | 'browser' | 'commission' | 'commands';
  size?: number;
  color?: string;
}): JSX.Element {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: color, style: { flex: 'none' } } as const;
  if (kind === 'attach') {
    return (
      <svg {...common} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.29 7.37l-6.13 6.13a4 4 0 0 1-5.66-5.66l5.71-5.71A2.67 2.67 0 1 1 12 5.89l-5.73 5.71a1.33 1.33 0 0 1-1.89-1.89l5.66-5.65" />
      </svg>
    );
  }
  if (kind === 'browser') {
    return (
      <svg {...common} strokeWidth={1.4}>
        <circle cx="8" cy="8" r="6.3" />
        <path d="M1.7 8h12.6M8 1.7c-1.8 1.8-2.7 4-2.7 6.3s.9 4.5 2.7 6.3c1.8-1.8 2.7-4 2.7-6.3S9.8 3.5 8 1.7z" />
      </svg>
    );
  }
  if (kind === 'commission') {
    // A pennant on a staff — the same mark the rail and the board use for a commission.
    return (
      <svg {...common} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round">
        <path d="M4.2 2.2v11.6" />
        <path d="M4.2 3.1h7.8L10.4 5.7l1.6 2.6H4.2z" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeWidth={1.6} strokeLinecap="round">
      <path d="M10.3 2.6 5.7 13.4" />
    </svg>
  );
}

/** The device list, shared by the ＋ menu's browser page and the capsule's own menu so the two
 *  entry points cannot drift apart. Includes the "off" row, which is how browsing is turned back off. */
function BrowserDeviceRows({ options, current, onPick }: {
  options: BrowserDeviceOption[];
  current: string | null;
  onPick: (device: string | null) => void;
}): JSX.Element {
  return (
    <>
      {options.map((o) => (
        <span
          key={o.device ?? '__off__'}
          data-device={o.device ?? '__off__'}
          onClick={(e) => { e.stopPropagation(); onPick(o.device); }}
          style={{
            ...MENU_ROW_STYLE, gap: 5,
            background: o.device === current ? 'var(--proto-accent-bg)' : 'transparent',
          }}
        >
          <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-ink)' }}>{o.label}</span>
          <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-muted-3)' }}>{o.sub}</span>
          {o.device === current && (
            <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 9, fontWeight: 700 }}>✓</span>
          )}
        </span>
      ))}
    </>
  );
}

/** The commission list, shared by the ＋ menu's commission page and the capsule's own menu, for the
 *  same reason as BrowserDeviceRows: two entry points, one list. The off row is how the mode is
 *  turned back off before the session exists. */
function CommissionOptionRows({ options, current, onPick }: {
  options: CommissionOption[];
  current: null | 'new' | string;
  onPick: (value: null | 'new' | string) => void;
}): JSX.Element {
  return (
    <>
      {options.map((o) => (
        <span
          key={o.value ?? '__off__'}
          data-commission-option={o.value ?? '__off__'}
          onClick={(e) => { e.stopPropagation(); onPick(o.value); }}
          style={{
            ...MENU_ROW_STYLE, gap: 5,
            background: o.value === current ? 'var(--proto-accent-bg)' : 'transparent',
          }}
        >
          <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{o.label}</span>
          <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-muted-3)' }}>{o.sub}</span>
          {o.value === current && (
            <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 9, fontWeight: 700 }}>✓</span>
          )}
        </span>
      ))}
    </>
  );
}

/**
 * The chosen browser, standing beside ＋ as a capsule.
 *
 * Opting in is otherwise invisible the moment the ＋ menu closes, and the choice is not a detail —
 * it decides which machine's screen the agent drives. So the selection keeps a marker on the
 * toolbar, and the marker IS the control: clicking it reopens the same device list, where another
 * machine is a switch and the off row ends browsing. No walk back through the ＋ menu.
 *
 * Nothing renders while browsing is off — an empty toolbar is the honest picture of no browser. A
 * live session's capsule only reports: the tool set is fixed when the agent process spawns.
 */
function ComposerBrowserChip({ browser }: { browser: ComposerBrowserControl }): JSX.Element | null {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useDismissMenu(open, close);
  const options = useBrowserDeviceOptions(open);
  const device = browser.device;
  const editable = !!browser.onChange;
  if (device === null) return null;
  const lit = open || hover;

  return (
    <span style={{ position: 'relative', flex: 'none', display: 'inline-flex' }}>
      <button
        type="button"
        data-chip="browser"
        data-browser-device={device}
        data-editable={editable ? 'true' : 'false'}
        aria-label={`${L.wbBrowser} · ${device}`}
        aria-expanded={editable ? open : undefined}
        onClick={editable ? (e) => { e.stopPropagation(); setOpen((o) => !o); } : undefined}
        onMouseEnter={() => { if (editable) setHover(true); }}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none',
          height: 30, maxWidth: 160, padding: '0 10px', boxSizing: 'border-box',
          borderRadius: 999,
          border: `1.5px solid ${lit ? 'var(--proto-accent)' : 'var(--proto-accent-border)'}`,
          background: 'var(--proto-accent-bg)',
          color: 'var(--proto-accent)',
          font: `500 10.5px ${MONO}`,
          cursor: editable ? 'pointer' : 'default',
        }}
      >
        <MenuIcon kind="browser" size={12} color="currentColor" />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{device}</span>
        {editable && <span style={{ fontSize: 7.5, opacity: 0.75 }}>▾</span>}
      </button>
      {open && editable && (
        <span
          data-menu="browser"
          style={{
            position: 'absolute', left: 0, bottom: 36, minWidth: 170,
            background: 'var(--proto-card)', border: '1px solid var(--proto-line)',
            borderRadius: 10, boxShadow: 'var(--shadow-menu)', zIndex: 59,
            overflow: 'hidden', display: 'block',
          }}
        >
          <BrowserDeviceRows
            options={options}
            current={device}
            onPick={(picked) => { close(); browser.onChange!(picked); }}
          />
        </span>
      )}
    </span>
  );
}

/**
 * The commission capsule, standing beside the browser one.
 *
 * The mode is the whole difference between "a conversation" and "a commitment with a contract
 * behind it", and after the ＋ menu closes there would otherwise be nothing on screen saying which
 * one this is. On a draft the capsule is also the control — clicking it reopens the same list,
 * where another commission is a switch and the off row backs out. On a live session it only
 * reports: the choice was made when the process spawned.
 */
function ComposerCommissionChip({ commission }: {
  commission: ComposerCommissionControl;
}): JSX.Element | null {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useDismissMenu(open, close);
  const options = useCommissionOptions(open);
  const value = commission.value;
  const editable = !!commission.onChange;
  if (value === null) return null;
  const lit = open || hover;
  // A draft that has not been named yet has no title to show, on either surface.
  const text = commission.label
    || (value === 'new' ? L.wbCommissionNewOption : L.wbCommissionUnnamed);

  return (
    <span style={{ position: 'relative', flex: 'none', display: 'inline-flex' }}>
      <button
        type="button"
        data-chip="commission"
        data-commission-value={value}
        data-editable={editable ? 'true' : 'false'}
        aria-label={`${L.wbCommissionMode} · ${text}`}
        aria-expanded={editable ? open : undefined}
        onClick={editable ? (e) => { e.stopPropagation(); setOpen((o) => !o); } : undefined}
        onMouseEnter={() => { if (editable) setHover(true); }}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none',
          height: 30, maxWidth: 180, padding: '0 10px', boxSizing: 'border-box',
          borderRadius: 999,
          border: `1.5px solid ${lit ? 'var(--proto-accent)' : 'var(--proto-accent-border)'}`,
          background: 'var(--proto-accent-bg)',
          color: 'var(--proto-accent)',
          font: `500 10.5px ${MONO}`,
          cursor: editable ? 'pointer' : 'default',
        }}
      >
        <MenuIcon kind="commission" size={12} color="currentColor" />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
        {editable && <span style={{ fontSize: 7.5, opacity: 0.75 }}>▾</span>}
      </button>
      {open && editable && (
        <span
          data-menu="commission"
          style={{
            position: 'absolute', left: 0, bottom: 36, minWidth: 190,
            background: 'var(--proto-card)', border: '1px solid var(--proto-line)',
            borderRadius: 10, boxShadow: 'var(--shadow-menu)', zIndex: 59,
            overflow: 'hidden', display: 'block',
          }}
        >
          <CommissionOptionRows
            options={options}
            current={value}
            onPick={(picked) => { close(); commission.onChange!(picked); }}
          />
        </span>
      )}
    </span>
  );
}

/**
 * The ＋ button and its menu — the single left-side entry point of the composer toolbar. Rarely-used
 * controls (attach, browser opt-in, local slash commands) fold in here so the toolbar itself stays
 * three elements: ＋, profile, send. The browser row opens a second menu page listing devices.
 */
function ComposerPlusMenu({ browser, commission, onAttach, onCommands }: {
  browser: ComposerBrowserControl | null;
  commission: ComposerCommissionControl | null;
  onAttach: () => void;
  onCommands: () => void;
}): JSX.Element {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<'root' | 'browser' | 'commission'>('root');
  const [hover, setHover] = useState(false);
  const close = useCallback(() => { setOpen(false); setPage('root'); }, []);
  useDismissMenu(open, close);
  const browserEditable = !!browser?.onChange;
  const commissionEditable = !!commission?.onChange;
  const options = useBrowserDeviceOptions(open && page === 'browser');
  const commissionOptions = useCommissionOptions(open && page === 'commission');
  const active = open || hover;
  const commissionLabel = commission?.label
    || (commission?.value === 'new' ? L.wbCommissionNewOption : null)
    || (commission?.value ? L.wbCommissionUnnamed : L.wbCommissionOffOption);

  return (
    <span style={{ position: 'relative', flex: 'none', display: 'inline-flex' }}>
      <button
        type="button"
        data-chip="plus"
        aria-label={L.wbPlusMenu}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); if (open) close(); else setOpen(true); }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: 30, height: 30, borderRadius: '50%', boxSizing: 'border-box', padding: 0, flex: 'none',
          border: `1.5px solid ${active ? 'var(--proto-accent-border)' : 'var(--proto-line-3)'}`,
          color: active ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
          background: 'var(--proto-card)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          lineHeight: 0, cursor: 'pointer',
        }}
      >
        <PlusGlyph />
      </button>
      {open && (
        <span
          data-menu="plus"
          style={{
            position: 'absolute', left: 0, bottom: 36, minWidth: 190,
            background: 'var(--proto-card)', border: '1px solid var(--proto-line)',
            borderRadius: 10, boxShadow: 'var(--shadow-menu)', zIndex: 59,
            overflow: 'hidden', display: 'block',
          }}
        >
          {page === 'root' ? (
            <>
              <span
                data-plus-item="attach"
                onClick={(e) => { e.stopPropagation(); close(); onAttach(); }}
                style={MENU_ROW_STYLE}
              >
                <MenuIcon kind="attach" />
                {L.wbAttach}
                <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>{L.wbAttachHint}</span>
              </span>
              {browser && (
                <span
                  data-plus-item="browser"
                  data-editable={browserEditable ? 'true' : 'false'}
                  onClick={browserEditable ? (e) => { e.stopPropagation(); setPage('browser'); } : undefined}
                  style={{ ...MENU_ROW_STYLE, cursor: browserEditable ? 'pointer' : 'default', opacity: browserEditable ? 1 : 0.6 }}
                >
                  <MenuIcon kind="browser" />
                  {L.wbBrowser}
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, font: `500 10px ${MONO}`, color: browser.device ? 'var(--proto-accent)' : 'var(--proto-muted-3)' }}>
                    {browser.device ?? L.wbBrowserOffOption}
                    {browserEditable && <span style={{ fontSize: 8, color: 'var(--proto-muted)' }}>▸</span>}
                  </span>
                </span>
              )}
              {commission && (
                <span
                  data-plus-item="commission"
                  data-editable={commissionEditable ? 'true' : 'false'}
                  onClick={commissionEditable ? (e) => { e.stopPropagation(); setPage('commission'); } : undefined}
                  style={{ ...MENU_ROW_STYLE, cursor: commissionEditable ? 'pointer' : 'default', opacity: commissionEditable ? 1 : 0.6 }}
                >
                  <MenuIcon kind="commission" />
                  {L.wbCommissionMode}
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, font: `500 10px ${MONO}`, color: commission.value ? 'var(--proto-accent)' : 'var(--proto-muted-3)', overflow: 'hidden' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{commissionLabel}</span>
                    {commissionEditable
                      ? <span style={{ fontSize: 8, color: 'var(--proto-muted)' }}>▸</span>
                      : <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-muted-3)' }}>{L.wbCommissionModeHint}</span>}
                  </span>
                </span>
              )}
              <span
                data-plus-item="commands"
                onClick={(e) => { e.stopPropagation(); close(); onCommands(); }}
                style={MENU_ROW_STYLE}
              >
                <MenuIcon kind="commands" />
                {L.commands}
              </span>
            </>
          ) : page === 'browser' ? (
            <>
              <span
                data-plus-back
                onClick={(e) => { e.stopPropagation(); setPage('root'); }}
                style={{ ...MENU_ROW_STYLE, minHeight: 28, borderBottom: '1px solid var(--proto-line-2)', color: 'var(--proto-muted)', fontSize: 11 }}
              >
                ‹ {L.wbBrowser}
              </span>
              <BrowserDeviceRows
                options={options}
                current={browser!.device}
                onPick={(device) => { close(); browser!.onChange!(device); }}
              />
            </>
          ) : (
            <>
              <span
                data-plus-back
                onClick={(e) => { e.stopPropagation(); setPage('root'); }}
                style={{ ...MENU_ROW_STYLE, minHeight: 28, borderBottom: '1px solid var(--proto-line-2)', color: 'var(--proto-muted)', fontSize: 11 }}
              >
                ‹ {L.wbCommissionMode}
              </span>
              <CommissionOptionRows
                options={commissionOptions}
                current={commission!.value}
                onPick={(value) => { close(); commission!.onChange!(value); }}
              />
            </>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The composer toolbar: the full-width row under the input. ＋ (attach / browser / commission /
 * commands) sits left, with the mode capsules beside it once a browser or commission is on;
 * profile, context ring and the send/stop cluster sit right, so every affordance shares one row and
 * the input above keeps the card's full width.
 */
export function ComposerActionRow({ browser, commission, onAttach, onCommands, profileControl, contextControl, sendControl }: {
  /** null hides the browser row entirely — a live session that never opted in has nothing to show. */
  browser: ComposerBrowserControl | null;
  /** null hides the commission row — a live session outside the mode has nothing to show. */
  commission: ComposerCommissionControl | null;
  onAttach: () => void;
  onCommands: () => void;
  profileControl: ReactNode;
  contextControl?: ReactNode;
  sendControl: ReactNode;
}): JSX.Element {
  return (
    <div data-composer-actions style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <ComposerPlusMenu browser={browser} commission={commission} onAttach={onAttach} onCommands={onCommands} />
      {browser && <ComposerBrowserChip browser={browser} />}
      {commission && <ComposerCommissionChip commission={commission} />}
      <span style={{ marginLeft: 'auto' }} />
      {profileControl}
      {contextControl}
      {sendControl}
    </div>
  );
}
