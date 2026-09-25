// input:  react, settings-ui, settings-style.css
// output: Glass editor panes, solid counts and wrapping footers
// pos:    Shared responsive settings editor layout primitives
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import type { CSSProperties, ReactNode } from 'react';
import { GROUP_STYLE, S_CONTROL_STYLE } from './settings-ui';
import './settings-style.css';

const MONO = "'IBM Plex Mono',monospace";

// Error changes only the existing boundary, never the control geometry.
export const CONTROL_ERROR_STYLE: CSSProperties = {
  ...S_CONTROL_STYLE, borderColor: 'var(--proto-danger)',
};

// Pair these styles with SETTINGS_CLASSES listPane/detailPane/editorColumns so
// the surface's container query can stack editors when the content area is narrow.
export function listPaneStyle(width: number): CSSProperties {
  return { ...GROUP_STYLE, width, maxWidth: '100%', flex: 'none', minHeight: 0 };
}

export const DETAIL_PANE_STYLE: CSSProperties = {
  ...GROUP_STYLE, flex: 1, minWidth: 0, minHeight: 0,
};

/** The panel root inside the modal's bounded frame, and the row of panes it holds. */
export const EDITOR_ROOT_STYLE: CSSProperties = {
  flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
};

export const EDITOR_COLUMNS_STYLE: CSSProperties = {
  display: 'flex', gap: 12, flex: 1, minWidth: 0, minHeight: 0, alignItems: 'stretch',
};

/** A pane header: a hairline under it, never a box around it. */
export const PANE_HEADER_STYLE: CSSProperties = {
  flex: 'none', padding: '12px 16px', borderBottom: '1px solid var(--proto-line-2)',
};

export const PANE_BODY_STYLE: CSSProperties = {
  flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', padding: 16,
};

export const LIST_BODY_STYLE: CSSProperties = {
  flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 8px',
};

export const LIST_EMPTY_STYLE: CSSProperties = {
  padding: '16px 12px', fontSize: 12, color: 'var(--proto-muted-3)', lineHeight: 1.7,
};

const PANE_TITLE_STYLE: CSSProperties = {
  fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)',
};

const PANE_COUNT_STYLE: CSSProperties = {
  font: `400 12px ${MONO}`, color: 'var(--proto-muted-2)',
};

const FILTER_ROW_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };

/** Counts inherit the chip's solid foreground in both neutral and selected states. */
export const CHIP_COUNT_STYLE: CSSProperties = { color: 'inherit' };

/**
 * Title and total, the filter chips, then the search field. The search attribute is passed as a
 * name because TypeScript does not type-check hyphenated JSX attributes, so a caller cannot hang
 * its own `data-*` hook on an input it does not render.
 */
export function ListHeader({ title, count, searchAttr, search, placeholder, onSearch, children }: {
  title: ReactNode;
  count: number;
  searchAttr: string;
  search: string;
  placeholder: string;
  onSearch: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="settings-pane-header" style={PANE_HEADER_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
        <span style={PANE_TITLE_STYLE}>{title}</span>
        <span style={PANE_COUNT_STYLE}>{count}</span>
      </div>
      <div style={FILTER_ROW_STYLE}>{children}</div>
      <input
        className="settings-control" {...{ [searchAttr]: '' }} value={search} placeholder={placeholder}
        onChange={(event) => onSearch(event.target.value)}
        style={{ ...S_CONTROL_STYLE, marginTop: 9 }}
      />
    </div>
  );
}

const FOOTER_STYLE: CSSProperties = {
  flex: 'none', borderTop: '1px solid var(--proto-line-2)', padding: '12px 16px',
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
};

// Hints can be prose or paths; callers opt individual identifiers into mono.
const FOOTER_HINT_STYLE: CSSProperties = {
  flex: '1 1 140px', minWidth: 0, fontSize: 12, color: 'var(--proto-muted-2)',
  overflowWrap: 'anywhere',
};

/** One footer shape for both editors: the hint on the left, the actions pinned right. */
export function PaneFooter({ hint, children }: { hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-pane-footer" style={FOOTER_STYLE}>
      <div style={FOOTER_HINT_STYLE}>{hint}</div>
      {children}
    </div>
  );
}

/** SNotice carries no outer margin, so a run of advisories needs a stack to sit in. */
export function NoticeStack({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, ...style }}>{children}</div>
  );
}

/** A master-list row: roomy enough to aim at, selected by a tint rather than an outline. */
export function listRowStyle(
  selected: boolean,
  align: CSSProperties['alignItems'] = 'center',
): CSSProperties {
  return {
    display: 'flex', alignItems: align, gap: 9, padding: '8px 10px',
    borderRadius: 'var(--settings-control-radius, 8px)', cursor: 'pointer',
    background: selected ? 'var(--proto-accent-bg)' : 'transparent',
  };
}
