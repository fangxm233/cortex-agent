// input:  pinned-preview dock state
// output: the chat-header control that docks the browser pane
// pos:    desktop entry point for the browser pane
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { CSSProperties } from 'react';
import { usePinnedPreview } from '@/features/media/PinnedPreviewProvider';
import { isWebPreviewItem } from '@/features/media/pinned-preview';
import { webItem } from './browser-target';

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
 * Docks the browser pane. Hidden where nothing can dock (mobile shell, routes with no dock host) —
 * same gate the preview modals use for their ◧ button.
 *
 * Toggling off unpins the whole dock, which is the same thing the pane's × does; a file preview
 * that happens to be docked is swapped for the browser instead of being closed.
 */
export function BrowserButton(): JSX.Element | null {
  const { canPin, active, item, pin, unpin } = usePinnedPreview();
  if (!canPin) return null;
  const showing = active && !!item && isWebPreviewItem(item);
  return (
    <button
      type="button"
      data-browser-button=""
      aria-pressed={showing}
      title="Preview a web page in the docked pane"
      onClick={() => (showing ? unpin() : pin(webItem('')))}
      style={buttonStyle(showing)}
    >
      <GlobeIcon />
      <span style={{ fontSize: 10.5, fontWeight: 600 }}>Web</span>
    </button>
  );
}
