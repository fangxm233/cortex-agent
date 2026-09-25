// input:  cmdk, palette-items, tRPC, routing
// output: CommandPalette, CommandPaletteProps
// pos:    Glass command search with readable compact results
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { useSettings } from '@/features/settings/useSettings';
import { useThreadDetailModal } from '@/features/thread/ThreadDetailModal';
import { selectPaletteRows, type PaletteRow } from './palette-items';

// ⌘K command palette — chrome and row anatomy follow glass-prototype.dc.html L370–386 (kind column,
// label, right-aligned hint); real sessions/threads/tasks over tRPC are substituted into that
// structure (§8.3: data is the only variable). cmdk drives the fuzzy filter + ↑/↓/Enter +
// focus-trap; the underlying Radix Dialog drives Esc/overlay-close + focus-restore. The
// prototype's static `i===0` highlight becomes cmdk's data-[selected] row.
// The fixed panel/backdrop live in index.css (`.cmdk-panel`/`.cmdk-backdrop`) — cmdk's Dialog only
// exposes overlay/content classNames, not style props.
//
// Deferred legs (flagged, plan §8.6): the prototype's "file" (EX), "Approvals" (AP) and
// "New schedule" (SC) rows have no real target yet — no fs-read scope (Stage 6), no approvals /
// schedule overlay (Stage R2+). The placeholder copy stays verbatim ("…/ file…"); results omitted.

const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '14px 16px',
  borderBottom: '1px solid var(--proto-line-2)',
};

const INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  color: 'var(--proto-ink)',
  fontFamily: 'inherit',
};

const ESC_STYLE: CSSProperties = {
  font: "400 11px 'IBM Plex Mono',monospace",
  color: 'var(--proto-muted)',
  background: 'transparent',
  border: '1px solid var(--proto-line)',
  borderRadius: 'var(--r-chip)',
  padding: '1px 5px',
  cursor: 'pointer',
};

// The prototype list holds ~7 curated rows with no cap; with real data we cap the row count in
// `selectPaletteRows` and add a max-height + scroll so the panel stays a fixed, usable height.
const BODY_STYLE: CSSProperties = { padding: 6, maxHeight: 384, overflowY: 'auto' };

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 34,
  padding: '0 10px',
  borderRadius: 'var(--r-chip)',
  cursor: 'pointer',
};

const KIND_STYLE: CSSProperties = {
  width: 64,
  flex: 'none',
  font: "600 11px 'IBM Plex Mono',monospace",
  letterSpacing: '.02em',
  textTransform: 'uppercase',
  color: 'var(--proto-muted)',
};

const HINT_STYLE: CSSProperties = {
  marginLeft: 'auto',
  font: "400 11px 'IBM Plex Mono',monospace",
  color: 'var(--proto-muted)',
  whiteSpace: 'nowrap',
  maxWidth: '35%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flex: '0 1 auto',
  paddingLeft: 10,
};

const FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '8px 16px',
  borderTop: '1px solid var(--proto-line-2)',
};

const FOOTER_TEXT_STYLE: CSSProperties = {
  font: "400 11px 'IBM Plex Mono',monospace",
  color: 'var(--proto-muted)',
};

const EMPTY_STYLE: CSSProperties = {
  padding: '18px 11px',
  textAlign: 'center',
  fontSize: 12.5,
  color: 'var(--proto-muted)',
};

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// A single palette row — kind column + label + right-aligned hint. cmdk sets
// `data-[selected=true]` on the arrow-selected (or mouse-hovered) row; the prototype highlight
// (var(--proto-accent-bg) bg, var(--proto-accent) label) is applied there via `.cmdk-row` CSS in index.css.
function Row({ row, onSelect }: { row: PaletteRow; onSelect: () => void }) {
  const L = useVocab();
  // Nav rows carry vocab keys → localized; entity rows carry real data in label/sub.
  const label = row.labelKey ? L[row.labelKey] : row.label;
  const sub = row.subKey ? L[row.subKey] : row.sub;
  // Nav rows are all commands; entity rows are named by their `kbd` tag. That tag is therefore
  // redundant in the hint for entities, but not for nav rows, where it says page vs modal.
  const kind = row.labelKey ? 'command' : row.kbd;
  const hint = [sub, row.kbd === kind ? null : row.kbd].filter(Boolean).join(' · ');
  return (
    <Command.Item value={row.id} onSelect={onSelect} className="cmdk-row" style={ROW_STYLE}>
      <span style={KIND_STYLE}>{kind}</span>
      <span className="cmdk-row-label">{label}</span>
      <span style={HINT_STYLE} title={hint}>{hint}</span>
    </Command.Item>
  );
}

const STALE = 30_000;

function usePaletteRows(open: boolean, query: string): PaletteRow[] {
  const trpc = useTRPC();
  const sessions = useQuery(trpc.sessions.list.queryOptions({}, { enabled: open, staleTime: STALE }));
  const threads = useQuery(trpc.threads.list.queryOptions({}, { enabled: open, staleTime: STALE }));
  const tasks = useQuery(trpc.tasks.list.queryOptions({}, { enabled: open, staleTime: STALE }));
  return useMemo(
    () => selectPaletteRows(query, {
      sessions: sessions.data ?? [], threads: threads.data ?? [], tasks: tasks.data ?? [],
    }),
    [query, sessions.data, threads.data, tasks.data],
  );
}

function usePaletteTarget(onOpenChange: (open: boolean) => void) {
  const navigate = useNavigate();
  const { open: openSettings } = useSettings();
  const { openThread } = useThreadDetailModal();
  return (row: PaletteRow) => {
    onOpenChange(false);
    if (row.modal === 'settings') return openSettings();
    if (row.modal === 'thread' && row.focusId) return openThread(row.focusId);
    if (row.route) navigate(row.route, row.focusId ? { state: { focusId: row.focusId } } : undefined);
  };
}

function PaletteHeader({ query, setQuery, close }: {
  query: string; setQuery: (value: string) => void; close: () => void;
}) {
  const L = useVocab();
  return (
    <div style={HEADER_STYLE}>
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="var(--proto-muted-3)" strokeWidth="1.5">
        <circle cx="5" cy="5" r="3.8" /><path d="M8 8l2.6 2.6" />
      </svg>
      <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder={L.cmdkPh} style={INPUT_STYLE} />
      <button type="button" aria-label="Close command palette" style={ESC_STYLE} onClick={close}>esc</button>
    </div>
  );
}

function PaletteResults({ rows, go }: { rows: PaletteRow[]; go: (row: PaletteRow) => void }) {
  const L = useVocab();
  return (
    <Command.List style={BODY_STYLE}>
      <Command.Empty style={EMPTY_STYLE}>{L.cpNoResults}</Command.Empty>
      {rows.map((row) => <Row key={row.id} row={row} onSelect={() => go(row)} />)}
    </Command.List>
  );
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const L = useVocab();
  const [query, setQuery] = useState('');
  useEffect(() => { if (open) setQuery(''); }, [open]);
  const rows = usePaletteRows(open, query);
  const go = usePaletteTarget(onOpenChange);
  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette"
      shouldFilter={false} loop overlayClassName="cmdk-backdrop" contentClassName="cmdk-panel">
      <PaletteHeader query={query} setQuery={setQuery} close={() => onOpenChange(false)} />
      <PaletteResults rows={rows} go={go} />
      <div style={FOOTER_STYLE}><span style={FOOTER_TEXT_STYLE}>{L.cpFooterHint}</span></div>
    </Command.Dialog>
  );
}
