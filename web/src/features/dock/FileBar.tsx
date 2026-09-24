// input:  file path, download callback, body controls
// output: FileBar, FileBarToggle
// pos:    File location and keyboard-accessible material controls
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
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
        <button type="button" data-file-download="" title="Download" aria-label="Download" onClick={onDownload} style={BUTTON_STYLE}>↓</button>
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
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      {...rest}
      style={{
        ...TOGGLE_STYLE,
        borderColor: on ? 'var(--proto-accent)' : 'var(--proto-line)',
        background: on ? 'var(--proto-accent-bg)' : 'var(--material-control-bg)',
        boxShadow: 'var(--material-control-shadow)',
        color: on ? 'var(--proto-accent)' : 'var(--proto-muted)',
      }}
    >{label}</button>
  );
}

const BAR_STYLE: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 10px',
  borderBottom: '1px solid var(--proto-line)',
  background: 'var(--material-card-bg)',
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
  font: `500 11px ${MONO}`,
  color: 'var(--proto-muted)',
};

const BUTTON_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 'var(--r-chip)',
  border: '1px solid var(--proto-line)',
  background: 'var(--material-control-bg)',
  boxShadow: 'var(--material-control-shadow)',
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
  borderRadius: 'var(--r-chip)',
  border: '1px solid var(--proto-line)',
  display: 'inline-flex',
  alignItems: 'center',
  font: `600 11px ${MONO}`,
  cursor: 'pointer',
  flex: 'none',
  userSelect: 'none',
  whiteSpace: 'nowrap',
};
