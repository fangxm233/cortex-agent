// input:  react, the settings kit
// output: the shell the bounded master–detail settings editors share — panes, headers, footers
// pos:    Hooks and Templates build their two columns out of these; the atoms live in settings-kit

import type { CSSProperties, ReactNode } from 'react';
import { GROUP_STYLE, S_CONTROL_STYLE } from './settings-ui';

const MONO = "'IBM Plex Mono',monospace";

// A field in error keeps its ring and only changes its colour. Swapping in a border instead would
// shift the control by a pixel every time the user typed something invalid.
export const CONTROL_ERROR_STYLE: CSSProperties = {
  ...S_CONTROL_STYLE, boxShadow: '0 0 0 1px var(--proto-danger)',
};

// Both columns are the same ringed glass card — fill, ring, radius from the kit — and differ only
// in how they take space. A ring rather than a border is what lets the two panes sit 14px apart on
// the sheet's glass without either edge reading as a seam.
export function listPaneStyle(width: number): CSSProperties {
  return { ...GROUP_STYLE, width, flex: 'none', minHeight: 0 };
}

export const DETAIL_PANE_STYLE: CSSProperties = {
  ...GROUP_STYLE, flex: 1, minWidth: 0, minHeight: 0,
};

/** The panel root inside the modal's bounded frame, and the row of panes it holds. */
export const EDITOR_ROOT_STYLE: CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
};

export const EDITOR_COLUMNS_STYLE: CSSProperties = {
  display: 'flex', gap: 14, flex: 1, minHeight: 0, alignItems: 'stretch',
};

/** A pane header: a hairline under it, never a box around it. */
export const PANE_HEADER_STYLE: CSSProperties = {
  flex: 'none', padding: '12px 14px', borderBottom: '1px solid var(--proto-line-2)',
};

export const PANE_BODY_STYLE: CSSProperties = {
  flex: 1, minHeight: 0, overflow: 'auto', padding: 14,
};

export const LIST_BODY_STYLE: CSSProperties = {
  flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 8px',
};

export const LIST_EMPTY_STYLE: CSSProperties = {
  padding: '16px 10px', fontSize: 11.5, color: 'var(--proto-muted-3)', lineHeight: 1.7,
};

const PANE_TITLE_STYLE: CSSProperties = {
  fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)',
};

const PANE_COUNT_STYLE: CSSProperties = {
  font: `400 10.5px ${MONO}`, color: 'var(--proto-muted-3)',
};

const FILTER_ROW_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };

/** The count a filter chip trails. Dimmed rather than re-coloured, so it reads in both chip states. */
export const CHIP_COUNT_STYLE: CSSProperties = { opacity: 0.6 };

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
    <div style={PANE_HEADER_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
        <span style={PANE_TITLE_STYLE}>{title}</span>
        <span style={PANE_COUNT_STYLE}>{count}</span>
      </div>
      <div style={FILTER_ROW_STYLE}>{children}</div>
      <input
        {...{ [searchAttr]: '' }} value={search} placeholder={placeholder}
        onChange={(event) => onSearch(event.target.value)}
        style={{ ...S_CONTROL_STYLE, marginTop: 9 }}
      />
    </div>
  );
}

const FOOTER_STYLE: CSSProperties = {
  flex: 'none', borderTop: '1px solid var(--proto-line-2)', padding: '10px 14px',
  display: 'flex', alignItems: 'center', gap: 8,
};

// Mono because a footer hint is always an identifier — a path, a reason code, an ordering rule.
const FOOTER_HINT_STYLE: CSSProperties = {
  flex: 1, minWidth: 0, font: `400 10.5px ${MONO}`, color: 'var(--proto-muted-3)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

/** One footer shape for both editors: the hint on the left, the actions pinned right. */
export function PaneFooter({ hint, children }: { hint?: ReactNode; children?: ReactNode }) {
  return (
    <div style={FOOTER_STYLE}>
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
    borderRadius: 'var(--r-chip)', cursor: 'pointer',
    background: selected ? 'var(--proto-accent-bg)' : 'transparent',
  };
}
