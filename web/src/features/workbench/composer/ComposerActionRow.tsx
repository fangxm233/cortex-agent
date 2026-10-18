import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Divider, MenuCard, MENU_SURFACE, MENU_BUTTON_STYLE, MENU_FOCUS, MENU_INSET, MENU_ROW_PAD_X } from '@/design/MenuChrome';
import { PlusGlyph } from '@/design';
import { useVocab } from '@/i18n';
import type { SlashSuggestion } from '@/features/session/composer/composer-slash';
import { useBrowserDeviceOptions, type BrowserDeviceOption } from '@/features/browser/BrowserOptIn';
import { QUIET_CHIP_GLYPH, quietChipStyle } from './composer-chip';

// A slash command is something the user types, so the command column alone takes the code face.
const CODE = 'var(--font-code)';

export function ComposerSlashMenu({ suggestions, activeIndex, onHover, onPick }: {
  suggestions: SlashSuggestion[];
  /** The keyboard/hover highlight; ⏎ takes this row. */
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (suggestion: SlashSuggestion) => void;
}): JSX.Element | null {
  const L = useVocab();
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const active = Math.min(activeIndex, suggestions.length - 1);
  useEffect(() => { activeRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
  if (suggestions.length === 0) return null;
  return (
    <div data-menu="slash" style={{ position: 'absolute', left: 0, right: 0, bottom: '100%', marginBottom: -2, border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)', ...MENU_SURFACE, overflow: 'hidden', zIndex: 10 }}>
      {/* The same inset rows as the composer's MenuCard menus: rounded tints that stop short of the
          card's edges, and a footer rule inset the same way. */}
      <div role="listbox" style={{ maxHeight: 320, overflowY: 'auto', padding: MENU_INSET }}>
        {suggestions.map((suggestion, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            ref={index === active ? activeRef : undefined}
            disabled={suggestion.disabled}
            className={MENU_FOCUS}
            key={suggestion.command}
            data-slash-command={suggestion.command}
            data-slash-active={index === active || undefined}
            onMouseEnter={() => onHover(index)}
            onClick={() => { if (!suggestion.disabled) onPick(suggestion); }}
            style={{ ...MENU_BUTTON_STYLE, display: 'flex', alignItems: 'center', minWidth: 0, padding: `8px ${MENU_ROW_PAD_X}px`, opacity: suggestion.disabled ? 0.45 : 1, background: index === active ? 'var(--proto-line-2)' : 'transparent', cursor: suggestion.disabled ? 'default' : 'pointer' }}
          >
            <span style={{ flex: 'none', font: `500 12px ${CODE}`, color: index === active ? 'var(--proto-ink)' : 'var(--proto-ink-2)' }}>{suggestion.command}</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, color: 'var(--proto-muted)', marginLeft: 12 }}>{suggestion.description}</span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', margin: `0 ${MENU_INSET}px`, padding: `7px ${MENU_ROW_PAD_X}px 8px`, borderTop: '1px solid var(--proto-line)', background: 'transparent' }}>
        <span style={{ fontSize: 12, color: 'var(--proto-faint)' }}>↑↓ {L.wbNavigate} · ⏎ {L.wbRun} · {L.wbEscDismiss}</span>
      </div>
    </div>
  );
}

/** Escape and outside-click dismissal, matching the model chip's menu. */
function useDismissMenu(open: boolean, close: () => void): void {
  useEffect(() => {
    // No window under SSR or a node test environment; the menu simply keeps no global listeners.
    if (!open || typeof window === 'undefined') return;
    const trigger = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
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

const MENU_ROW_STYLE: CSSProperties = {
  ...MENU_BUTTON_STYLE, background: 'transparent',
  display: 'flex', alignItems: 'center', gap: 9, minHeight: 32, padding: `0 ${MENU_ROW_PAD_X}px`,
  cursor: 'pointer', fontSize: 13, color: 'var(--proto-ink)',
};

/** Row glyphs for the ＋ menu — same 16-unit line-art family the mobile attach menu uses, so the
 *  two surfaces read as one menu. Muted stroke: the label carries the row, the icon only anchors it. */
function MenuIcon({ kind, size = 14, color = 'var(--proto-muted)' }: {
  kind: 'attach' | 'browser' | 'commands';
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
        <button
          type="button"
          className={MENU_FOCUS}
          aria-pressed={o.device === current}
          key={o.device ?? '__off__'}
          data-device={o.device ?? '__off__'}
          onClick={(e) => { e.stopPropagation(); onPick(o.device); }}
          style={{
            ...MENU_ROW_STYLE, gap: 6,
            background: o.device === current ? 'var(--proto-line-2)' : 'transparent',
          }}
        >
          <span style={{ fontWeight: 500, color: 'var(--proto-ink)' }}>{o.label}</span>
          <span style={{ fontSize: 12.5, color: 'var(--proto-muted)' }}>{o.sub}</span>
          {o.device === current && (
            <span style={{ marginLeft: 'auto', color: 'var(--proto-ink)', fontSize: 12, fontWeight: 700 }}>✓</span>
          )}
        </button>
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
        className={MENU_FOCUS}
        data-chip="browser"
        data-browser-device={device}
        data-editable={editable ? 'true' : 'false'}
        aria-label={`${L.wbBrowser} · ${device}`}
        aria-expanded={editable ? open : undefined}
        onClick={editable ? (e) => { e.stopPropagation(); setOpen((o) => !o); } : undefined}
        onMouseEnter={() => { if (editable) setHover(true); }}
        onMouseLeave={() => setHover(false)}
        style={{ ...quietChipStyle(lit), flex: 'none', maxWidth: 160, cursor: editable ? 'pointer' : 'default' }}
      >
        <MenuIcon kind="browser" size={12} color={QUIET_CHIP_GLYPH} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{device}</span>
        {editable && <span aria-hidden="true" style={{ fontSize: 8, color: QUIET_CHIP_GLYPH }}>▾</span>}
      </button>
      {open && editable && (
        <MenuCard kind="browser" align="left" minWidth={170}>
          <BrowserDeviceRows
            options={options}
            current={device}
            onPick={(picked) => { close(); browser.onChange!(picked); }}
          />
        </MenuCard>
      )}
    </span>
  );
}

/**
 * The ＋ button and its menu — the single left-side entry point of the composer toolbar. Rarely-used
 * controls (attach, browser opt-in, local slash commands) fold in here so the toolbar itself stays
 * three elements: ＋, model, send. The browser row opens a second menu page listing devices.
 */
function ComposerPlusMenu({ browser, onAttach, onCommands }: {
  browser: ComposerBrowserControl | null;
  onAttach: () => void;
  onCommands: () => void;
}): JSX.Element {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<'root' | 'browser'>('root');
  const [hover, setHover] = useState(false);
  const close = useCallback(() => { setOpen(false); setPage('root'); }, []);
  useDismissMenu(open, close);
  const browserEditable = !!browser?.onChange;
  const options = useBrowserDeviceOptions(open && page === 'browser');
  const active = open || hover;

  return (
    <span style={{ position: 'relative', flex: 'none', display: 'inline-flex' }}>
      <button
        type="button"
        className={MENU_FOCUS}
        data-chip="plus"
        aria-label={L.wbPlusMenu}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); if (open) close(); else setOpen(true); }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          // A transparent circle: muted ＋ at rest, a gray tint and ink on hover or while open.
          width: 30, height: 30, borderRadius: '50%', boxSizing: 'border-box', padding: 0, flex: 'none',
          border: 0,
          color: active ? 'var(--proto-ink)' : 'var(--proto-muted)',
          background: open ? 'var(--proto-gray)' : hover ? 'var(--proto-line-2)' : 'transparent',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          lineHeight: 0, cursor: 'pointer',
        }}
      >
        <PlusGlyph />
      </button>
      {open && (
        <MenuCard kind="plus" align="left" minWidth={190}>
          {page === 'root' ? (
            <>
              <button
                type="button" className={MENU_FOCUS}
                data-plus-item="attach"
                onClick={(e) => { e.stopPropagation(); close(); onAttach(); }}
                style={MENU_ROW_STYLE}
              >
                <MenuIcon kind="attach" />
                {L.wbAttach}
                <span style={{ marginLeft: 'auto', paddingLeft: 12, fontSize: 12, color: 'var(--proto-faint)' }}>{L.wbAttachHint}</span>
              </button>
              {browser && (
                <button
                  type="button" className={MENU_FOCUS} disabled={!browserEditable}
                  data-plus-item="browser"
                  data-editable={browserEditable ? 'true' : 'false'}
                  onClick={browserEditable ? (e) => { e.stopPropagation(); setPage('browser'); } : undefined}
                  style={{ ...MENU_ROW_STYLE, cursor: browserEditable ? 'pointer' : 'default', opacity: browserEditable ? 1 : 0.6 }}
                >
                  <MenuIcon kind="browser" />
                  {L.wbBrowser}
                  <span style={{ marginLeft: 'auto', paddingLeft: 12, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: browser.device ? 'var(--proto-ink-2)' : 'var(--proto-muted)' }}>
                    {browser.device ?? L.wbBrowserOffOption}
                    {browserEditable && <span style={{ fontSize: 8, color: 'var(--proto-muted)' }}>▸</span>}
                  </span>
                </button>
              )}
              <button
                type="button" className={MENU_FOCUS}
                data-plus-item="commands"
                onClick={(e) => { e.stopPropagation(); close(); onCommands(); }}
                style={MENU_ROW_STYLE}
              >
                <MenuIcon kind="commands" />
                {L.commands}
              </button>
            </>
          ) : (
            <>
              <button
                type="button" className={MENU_FOCUS}
                data-plus-back
                onClick={(e) => { e.stopPropagation(); setPage('root'); }}
                style={{ ...MENU_ROW_STYLE, minHeight: 28, color: 'var(--proto-muted)', fontSize: 12, fontWeight: 550 }}
              >
                ‹ {L.wbBrowser}
              </button>
              <Divider />
              <BrowserDeviceRows
                options={options}
                current={browser!.device}
                onPick={(device) => { close(); browser!.onChange!(device); }}
              />
            </>
          )}
        </MenuCard>
      )}
    </span>
  );
}

/**
 * The composer toolbar: the full-width row under the input. ＋ (attach / browser / commands) sits
 * left, with the browser capsule beside it once a browser is on; agent,
 * model, context ring and the send/stop cluster sit right, so every affordance shares one row and
 * the input above keeps the card's full width.
 *
 * The right cluster reads outside-in: WHERE the turn runs (the environment), then WHAT runs it (the
 * engine), then how much room is left, then send.
 */
export function ComposerActionRow({ browser, onAttach, onCommands, agentControl, selectionControl, contextControl, sendControl }: {
  /** null hides the browser row entirely — a live session that never opted in has nothing to show. */
  browser: ComposerBrowserControl | null;
  onAttach: () => void;
  onCommands: () => void;
  /** The environment chip (which agent the conversation runs in). Draws nothing of its own on a
   *  host with fewer than two agents — a list of one is not a choice. */
  agentControl?: ReactNode;
  /** The engine chip (model + model + thinking). */
  selectionControl: ReactNode;
  contextControl?: ReactNode;
  sendControl: ReactNode;
}): JSX.Element {
  return (
    <div data-composer-actions style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
      <ComposerPlusMenu browser={browser} onAttach={onAttach} onCommands={onCommands} />
      {browser && <ComposerBrowserChip browser={browser} />}
      <span style={{ marginLeft: 'auto' }} />
      {agentControl}
      {selectionControl}
      {contextControl}
      {sendControl}
    </div>
  );
}
