// input:  ＋ menu actions, browser control, profile/context/send nodes
// output: Desktop composer toolbar row (＋ menu left, send cluster right) and slash menu
// pos:    Groups composer shortcuts and controls under the input
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useVocab } from '@/i18n';
import type { SlashSuggestion } from './composer-slash';
import { useBrowserDeviceOptions } from './BrowserOptIn';

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

const MENU_ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, minHeight: 32, padding: '0 13px',
  cursor: 'pointer', fontSize: 12, color: 'var(--proto-ink)',
};

/**
 * The ＋ button and its menu — the single left-side entry point of the composer toolbar. Rarely-used
 * controls (attach, browser opt-in, local slash commands) fold in here so the toolbar itself stays
 * three elements: ＋, profile, send. The browser row opens a second menu page listing devices.
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
        data-chip="plus"
        aria-label={L.wbPlusMenu}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); if (open) close(); else setOpen(true); }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: 30, height: 30, borderRadius: '50%', boxSizing: 'border-box', padding: 0, flex: 'none',
          border: `1px solid ${active ? 'var(--proto-accent-border)' : 'var(--proto-line)'}`,
          color: active ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
          background: 'var(--proto-card)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 17, fontWeight: 300, lineHeight: 1, cursor: 'pointer',
        }}
      >
        ＋
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
                  {L.wbBrowser}
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, font: `500 10px ${MONO}`, color: browser.device ? 'var(--proto-accent)' : 'var(--proto-muted-3)' }}>
                    {browser.device ?? L.wbBrowserOffOption}
                    {browserEditable && <span style={{ fontSize: 8, color: 'var(--proto-muted)' }}>▸</span>}
                  </span>
                </span>
              )}
              <span
                data-plus-item="commands"
                onClick={(e) => { e.stopPropagation(); close(); onCommands(); }}
                style={MENU_ROW_STYLE}
              >
                <span style={{ font: `600 12px ${MONO}` }}>/</span> {L.commands}
              </span>
            </>
          ) : (
            <>
              <span
                data-plus-back
                onClick={(e) => { e.stopPropagation(); setPage('root'); }}
                style={{ ...MENU_ROW_STYLE, minHeight: 28, borderBottom: '1px solid var(--proto-line-2)', color: 'var(--proto-muted)', fontSize: 11 }}
              >
                ‹ {L.wbBrowser}
              </span>
              {options.map((o) => (
                <span
                  key={o.device ?? '__off__'}
                  data-device={o.device ?? '__off__'}
                  onClick={(e) => { e.stopPropagation(); close(); browser!.onChange!(o.device); }}
                  style={{
                    ...MENU_ROW_STYLE, gap: 5,
                    background: o.device === browser!.device ? 'var(--proto-accent-bg)' : 'transparent',
                  }}
                >
                  <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-ink)' }}>{o.label}</span>
                  <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-muted-3)' }}>{o.sub}</span>
                  {o.device === browser!.device && (
                    <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 9, fontWeight: 700 }}>✓</span>
                  )}
                </span>
              ))}
            </>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The composer toolbar: the full-width row under the input. ＋ (attach / browser / commands) sits
 * left; profile, context ring and the send/stop cluster sit right, so every affordance shares one
 * row and the input above keeps the card's full width.
 */
export function ComposerActionRow({ browser, onAttach, onCommands, profileControl, contextControl, sendControl }: {
  /** null hides the browser row entirely — a live session that never opted in has nothing to show. */
  browser: ComposerBrowserControl | null;
  onAttach: () => void;
  onCommands: () => void;
  profileControl: ReactNode;
  contextControl?: ReactNode;
  sendControl: ReactNode;
}): JSX.Element {
  return (
    <div data-composer-actions style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <ComposerPlusMenu browser={browser} onAttach={onAttach} onCommands={onCommands} />
      <span style={{ marginLeft: 'auto' }} />
      {profileControl}
      {contextControl}
      {sendControl}
    </div>
  );
}
