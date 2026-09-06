// input:  dock state
// output: the chat-header control that opens a web tab in the dock
// pos:    desktop entry point for the browser
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { CSSProperties } from 'react';
import { useDock } from '@/features/dock/DockProvider';

function buttonStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: active ? '1.5px solid var(--proto-accent)' : '1px solid var(--proto-line)',
    borderRadius: 7,
    padding: '4px 9px',
    background: active ? 'var(--proto-accent-bg)' : 'var(--proto-card)',
    color: active ? 'var(--proto-accent)' : 'var(--proto-ink)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  };
}

function GlobeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="7" cy="7" r="5.6" />
      <path d="M1.4 7h11.2M7 1.4c1.6 1.7 2.4 3.6 2.4 5.6S8.6 10.9 7 12.6C5.4 10.9 4.6 9 4.6 7S5.4 3.1 7 1.4z" />
    </svg>
  );
}

/**
 * Opens a web tab in the dock. Hidden where nothing can dock (mobile shell, routes with no dock
 * host) — the same gate the preview modals use for their ◧ button.
 *
 * It ADDS to the dock rather than taking it over: a docked file preview keeps its own tab, and a
 * blank web tab that is already open is focused instead of duplicated. The dock's × closes it.
 */
export function BrowserButton(): JSX.Element | null {
  const { canDock, active, activeTab, openWeb } = useDock();
  if (!canDock) return null;
  const showing = active && activeTab?.kind === 'web';
  return (
    <button
      type="button"
      data-browser-button=""
      aria-pressed={showing}
      title="Open a web page in the dock"
      onClick={openWeb}
      style={buttonStyle(showing)}
    >
      <GlobeIcon />
      <span style={{ fontSize: 10.5, fontWeight: 600 }}>Web</span>
    </button>
  );
}
