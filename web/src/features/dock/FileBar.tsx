// input:  a docked file's workspace path and its host actions
// output: the identity-and-actions row a docked file body owns
// pos:    Dock chrome for non-PDF files; the PDF pager plays the same role
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { CSSProperties, ReactNode } from 'react';

// A docked tab has no header of its own — the strip above is shared by every tab — so each file body
// carries this row: where the file is, and what can be done with it. A PDF already has such a row
// (its page pager), and takes its actions there instead of growing a second one.

const MONO = "'IBM Plex Mono',monospace";

export function FileBar({ path, onDownload, children }: {
  /** Workspace-relative path; the row is only worth rendering when the file has one. */
  path: string;
  onDownload?: () => void;
  /** Body-specific controls placed left of the download (the Markdown source toggle). */
  children?: ReactNode;
}): JSX.Element {
  return (
    <div style={BAR_STYLE}>
      {/* Paths are long and their INFORMATIVE end is the tail, so the ellipsis goes at the front:
          `direction: rtl` moves it there, and `unicode-bidi: plaintext` keeps the text itself LTR. */}
      <span data-file-path={path} title={path} style={PATH_STYLE}>{path}</span>
      {children}
      {onDownload && (
        <span role="button" data-file-download="" title="Download" onClick={onDownload} style={BUTTON_STYLE}>↓</span>
      )}
    </div>
  );
}

/** A compact toggle in the bar's action run — used for Markdown's rendered/source switch. */
export function FileBarToggle({ on, label, title, onClick, ...rest }: {
  on: boolean;
  label: string;
  title: string;
  onClick: () => void;
} & Record<`data-${string}`, string>): JSX.Element {
  return (
    <span
      role="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      {...rest}
      style={{
        ...TOGGLE_STYLE,
        borderColor: on ? 'var(--proto-accent)' : 'var(--proto-line)',
        background: on ? 'var(--proto-accent-bg)' : 'var(--proto-card)',
        color: on ? 'var(--proto-accent)' : 'var(--proto-muted)',
      }}
    >{label}</span>
  );
}

const BAR_STYLE: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 10px',
  borderBottom: '1px solid var(--proto-line)',
  background: 'var(--proto-rail)',
};

const PATH_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  direction: 'rtl',
  textAlign: 'left',
  unicodeBidi: 'plaintext',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  font: `500 10.5px ${MONO}`,
  color: 'var(--proto-muted-2)',
};

const BUTTON_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  border: '1px solid var(--proto-line)',
  background: 'var(--proto-card)',
  color: 'var(--proto-muted)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  cursor: 'pointer',
  flex: 'none',
  userSelect: 'none',
};

const TOGGLE_STYLE: CSSProperties = {
  height: 22,
  padding: '0 8px',
  borderRadius: 6,
  border: '1px solid var(--proto-line)',
  display: 'inline-flex',
  alignItems: 'center',
  font: `600 10px ${MONO}`,
  cursor: 'pointer',
  flex: 'none',
  userSelect: 'none',
  whiteSpace: 'nowrap',
};
