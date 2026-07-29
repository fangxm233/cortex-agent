// input:  active note count, drawer state and localized copy
// output: persistent desktop project-header notes button
// pos:    Scheme 26a desktop notes entry control
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { CSSProperties } from 'react';
import type { NotesCopy } from './notes-copy';

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

function NotesIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M9.8 1.8l2.4 2.4L4.6 11.8l-3 .6.6-3z" />
    </svg>
  );
}

export function NotesButton({ count, active, copy, onClick }: {
  count: number;
  active: boolean;
  copy: NotesCopy;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-notes-button=""
      aria-pressed={active}
      onClick={onClick}
      title={`${copy.title} · ⌘⇧N`}
      style={buttonStyle(active)}
    >
      <NotesIcon />
      <span style={{ fontSize: 10.5, fontWeight: 600 }}>{copy.title}</span>
      <span style={{ font: "600 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-accent)' }}>{count}</span>
    </button>
  );
}
