import type { CSSProperties, ReactNode } from 'react';
import { IconButton } from '@/design/IconButton';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { useVocabOptional } from '@/i18n';

// A docked tab has no header of its own — the strip above is shared by every tab — so each file body
// carries this row: where the file is, and what can be done with it. A PDF already has such a row
// (its page pager), and takes its actions there instead of growing a second one.
//
// The path is the one thing here a person would copy, so it alone takes the code face; the controls
// are neutral — a transparent icon button and a quiet toggle, a gray tint when on.

export function FileBar({ path, onDownload, children }: {
  /** Workspace-relative path; the row is only worth rendering when the file has one. */
  path: string;
  onDownload?: () => void;
  /** Body-specific controls placed left of the download (the Markdown source toggle). */
  children?: ReactNode;
}): JSX.Element {
  const L = useVocabOptional();
  return (
    <div style={BAR_STYLE}>
      {/* Paths are long and their INFORMATIVE end is the tail, so the ellipsis goes at the front:
          `direction: rtl` moves it there, and `unicode-bidi: plaintext` keeps the text itself LTR. */}
      <span data-file-path={path} title={path} style={PATH_STYLE}>{path}</span>
      {children}
      {onDownload && (
        <IconButton data-file-download="" label={L.cmDownload} size={28} onClick={onDownload}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
          </svg>
        </IconButton>
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
      className={on ? MENU_FOCUS : `${MENU_FOCUS} text-proto-muted hover:bg-proto-line-2 hover:text-proto-ink`}
      style={{
        ...TOGGLE_STYLE,
        ...(on ? { background: 'var(--proto-gray)', color: 'var(--proto-ink)' } : null),
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
  font: '400 11.5px var(--font-code)',
  color: 'var(--proto-muted)',
};

const TOGGLE_STYLE: CSSProperties = {
  height: 24,
  padding: '0 9px',
  borderRadius: 'var(--r-chip)',
  border: 0,
  display: 'inline-flex',
  alignItems: 'center',
  font: '500 12px var(--font-ui)',
  cursor: 'pointer',
  flex: 'none',
  userSelect: 'none',
  whiteSpace: 'nowrap',
};
