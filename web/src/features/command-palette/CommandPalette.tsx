import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { selectPaletteRows, type PaletteRow } from './palette-items';

// ⌘K command palette — 1:1 rebuild from prototype.dc.html L1295–1315 (task c967). The overlay
// chrome, row anatomy, and copy are reproduced verbatim (exact inline styles / px / hex / font /
// weight — LeftRail/CenterChat/RightPanel raw-value precedent); real sessions/threads/tasks over
// tRPC are substituted into the exact structure (§8.3: data is the only variable). cmdk drives the
// fuzzy filter + ↑/↓/Enter + focus-trap; the underlying Radix Dialog drives Esc/overlay-close +
// focus-restore. The prototype's static `i===0` highlight becomes cmdk's data-[selected] row.
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
  padding: '12px 16px',
  borderBottom: '1px solid #EFF1F5',
};

const INPUT_STYLE: CSSProperties = {
  flex: 1,
  fontSize: 13.5,
  color: '#191C22',
  fontFamily: 'inherit',
};

const ESC_STYLE: CSSProperties = {
  font: "500 9.5px 'IBM Plex Mono',monospace",
  color: '#98A1B0',
  border: '1px solid #E7E9EE',
  borderRadius: 5,
  padding: '2px 6px',
  cursor: 'pointer',
};

// The prototype list holds ~7 curated rows with no cap; with real data we cap the row count in
// `selectPaletteRows` and add a max-height + scroll so the panel stays a fixed, usable height.
const BODY_STYLE: CSSProperties = { padding: 6, maxHeight: 384, overflowY: 'auto' };

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 11px',
  borderRadius: 8,
  cursor: 'pointer',
};

const GLYPH_STYLE: CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 6,
  background: '#F1F2F5',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  font: "600 9px 'IBM Plex Mono',monospace",
  color: '#5B6472',
  flex: 'none',
};

const SUB_STYLE: CSSProperties = {
  fontSize: 10.5,
  color: '#98A1B0',
  whiteSpace: 'nowrap',
  flex: 'none',
};

const KBD_STYLE: CSSProperties = {
  marginLeft: 'auto',
  font: "400 9.5px 'IBM Plex Mono',monospace",
  color: '#B6BDC9',
  flex: 'none',
  paddingLeft: 10,
};

const FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '7px 16px',
  borderTop: '1px solid #F7F8FA',
  background: '#FBFBFC',
};

const FOOTER_TEXT_STYLE: CSSProperties = {
  font: "400 9.5px 'IBM Plex Mono',monospace",
  color: '#B6BDC9',
};

const EMPTY_STYLE: CSSProperties = {
  padding: '18px 11px',
  textAlign: 'center',
  fontSize: 12.5,
  color: '#98A1B0',
};

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// A single palette row — glyph badge + label + sub + right-aligned kbd. cmdk sets
// `data-[selected=true]` on the arrow-selected (or mouse-hovered) row; the prototype highlight
// (#F5F6FD bg, #4655D4 label) is applied there via `.cmdk-row` CSS in index.css.
function Row({ row, onSelect }: { row: PaletteRow; onSelect: () => void }) {
  const L = useVocab();
  // Nav rows carry vocab keys → localized; entity rows carry real data in label/sub.
  const label = row.labelKey ? L[row.labelKey] : row.label;
  const sub = row.subKey ? L[row.subKey] : row.sub;
  return (
    <Command.Item value={row.id} onSelect={onSelect} className="cmdk-row" style={ROW_STYLE}>
      <span style={GLYPH_STYLE}>{row.glyph}</span>
      <span className="cmdk-row-label">{label}</span>
      <span style={SUB_STYLE}>{sub}</span>
      <span style={KBD_STYLE}>{row.kbd}</span>
    </Command.Item>
  );
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const L = useVocab();
  const [query, setQuery] = useState('');

  // Reset the query each time the palette opens (fresh search).
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  // Fetch the three lists only while the palette is open. `staleTime` lets the palette reuse the
  // workbench's already-cached `sessions.list({})` instead of forcing a refetch on every open — a
  // duplicate refetch entangles the shared httpBatchLink GET (sessions is also owned by the left
  // rail) and the whole batch never settles, leaving threads/tasks stuck pending.
  const STALE = 30_000;
  const sessionsQuery = useQuery(trpc.sessions.list.queryOptions({}, { enabled: open, staleTime: STALE }));
  const threadsQuery = useQuery(trpc.threads.list.queryOptions({}, { enabled: open, staleTime: STALE }));
  const tasksQuery = useQuery(trpc.tasks.list.queryOptions({}, { enabled: open, staleTime: STALE }));

  // We filter + cap ourselves (cmdk `shouldFilter={false}`): feeding cmdk every real entity
  // renders hundreds of rows, which stalls the shared httpBatchLink fetch and blows up the panel.
  const rows = useMemo<PaletteRow[]>(
    () =>
      selectPaletteRows(query, {
        sessions: sessionsQuery.data ?? [],
        threads: threadsQuery.data ?? [],
        tasks: tasksQuery.data ?? [],
      }),
    [query, sessionsQuery.data, threadsQuery.data, tasksQuery.data],
  );

  const go = (route: string, focusId?: string) => {
    navigate(route, focusId ? { state: { focusId } } : undefined);
    onOpenChange(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      shouldFilter={false}
      loop
      overlayClassName="cmdk-backdrop"
      contentClassName="cmdk-panel"
    >
      <div style={HEADER_STYLE}>
        <svg
          width="13"
          height="13"
          viewBox="0 0 12 12"
          fill="none"
          stroke="#98A1B0"
          strokeWidth="1.5"
        >
          <circle cx="5" cy="5" r="3.8" />
          <path d="M8 8l2.6 2.6" />
        </svg>
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={L.cmdkPh}
          style={INPUT_STYLE}
        />
        <span style={ESC_STYLE} onClick={() => onOpenChange(false)}>
          esc
        </span>
      </div>

      <Command.List style={BODY_STYLE}>
        <Command.Empty style={EMPTY_STYLE}>{L.cpNoResults}</Command.Empty>
        {rows.map((row) => (
          <Row key={row.id} row={row} onSelect={() => go(row.route, row.focusId)} />
        ))}
      </Command.List>

      <div style={FOOTER_STYLE}>
        <span style={FOOTER_TEXT_STYLE}>{L.cpFooterHint}</span>
      </div>
    </Command.Dialog>
  );
}
