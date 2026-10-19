import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { useSettings } from '@/features/settings/useSettings';
import { useDockIntake } from '@/design/dock-intake';
import { useAgentBrowsers } from '@/features/agent-browser/useAgentBrowsers';
import {
  groupPaletteRows, labelSegments, paletteGroupLabel, selectPaletteRows, type PaletteRow,
} from './palette-items';

// ⌘K command palette — a search row over headed groups of results (Panels mockup): real sessions
// and boards over tRPC fill the structure. cmdk drives the ↑/↓/Enter + focus-trap; the underlying
// Radix Dialog drives Esc/overlay-close + focus-restore. The arrow-selected row is cmdk's
// data-[selected] row, tinted gray in index.css — selection is a surface, not an accent colour.
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
  height: 50,
  padding: '0 16px',
  borderBottom: '1px solid var(--proto-line-2)',
};

const INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 14.5,
  color: 'var(--proto-ink)',
  fontFamily: 'var(--font-ui)',
};

// The prototype list holds ~7 curated rows with no cap; with real data we cap the row count in
// `selectPaletteRows` and add a max-height + scroll so the panel stays a fixed, usable height.
const BODY_STYLE: CSSProperties = { padding: '0 6px 6px', maxHeight: 384, overflowY: 'auto', scrollbarGutter: 'stable' };

const GROUP_HEADING_STYLE: CSSProperties = {
  padding: '10px 10px 4px',
  fontSize: 12,
  fontWeight: 550,
  color: 'var(--proto-muted-3)',
};

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 36,
  padding: '0 10px',
  borderRadius: 'var(--r-chip)',
  cursor: 'pointer',
};

const ICON_STYLE: CSSProperties = {
  width: 16,
  flex: 'none',
  display: 'flex',
  justifyContent: 'center',
  color: 'var(--proto-muted-3)',
};

const HINT_STYLE: CSSProperties = {
  marginLeft: 'auto',
  fontSize: 12,
  color: 'var(--proto-muted-3)',
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
  gap: 14,
  padding: '9px 16px',
  borderTop: '1px solid var(--proto-line-2)',
  fontSize: 12,
  color: 'var(--proto-muted-3)',
};

const KEYCAP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 18,
  height: 18,
  padding: '0 4px',
  marginRight: 4,
  boxSizing: 'border-box',
  borderRadius: 5,
  background: 'var(--proto-gray)',
  // A <kbd> defaults to the code face; a key hint is a label, so it stays in the UI face.
  fontFamily: 'var(--font-ui)',
  fontSize: 11,
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

// One stroked glyph per group, drawn on a 16×16 grid at 14px: the column is scanned, not read.
const GROUP_ICON_PATHS: Record<string, string> = {
  page: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  action: 'M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6',
  browser: 'M3.5 3h9a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3zM2 6h12M7.5 8.5l2.5 2.5M7.5 8.5v3l1-1',
  board: 'M4 14V2.5M4 3h8l-2 3 2 3H4',
  session: 'M3 4h10v7H7l-3 2.5V11H3z',
};

function GroupIcon({ group }: { group: string }) {
  const path = GROUP_ICON_PATHS[group];
  if (!path) return <span style={ICON_STYLE} />;
  return (
    <span style={ICON_STYLE}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={path} />
      </svg>
    </span>
  );
}

// A single palette row — kind glyph + label + right-aligned hint. cmdk sets
// `data-[selected=true]` on the arrow-selected (or mouse-hovered) row; its gray tint and ink label
// come from `.cmdk-row` CSS in index.css.
// What was typed reads bolder in the label, so a long list shows at a glance why each row is there.
const MATCH_STYLE: CSSProperties = { fontWeight: 650, color: 'var(--proto-ink)' };

function Row({ row, group, query, onSelect }: { row: PaletteRow; group: string; query: string; onSelect: () => void }) {
  const L = useVocab();
  // Nav rows carry vocab keys → localized; entity rows carry real data in label/sub. The group
  // heading names the kind, so the hint is only the row's own context (a project, a section list).
  const label = row.labelKey ? L[row.labelKey] : row.label;
  const hint = row.subKey ? L[row.subKey] : row.sub;
  return (
    <Command.Item value={row.id} onSelect={onSelect} className="cmdk-row" style={ROW_STYLE}>
      <GroupIcon group={group} />
      <span className="cmdk-row-label">
        {labelSegments(label, query).map((segment, index) => {
          const key = `${index}:${segment.text}`;
          return segment.match
            ? <b key={key} data-palette-match="" style={MATCH_STYLE}>{segment.text}</b>
            : <span key={key}>{segment.text}</span>;
        })}
      </span>
      <span style={HINT_STYLE} title={hint}>{hint}</span>
    </Command.Item>
  );
}

const STALE = 30_000;

function usePaletteRows(open: boolean, query: string): PaletteRow[] {
  const trpc = useTRPC();
  const L = useVocab();
  const sessions = useQuery(trpc.sessions.list.queryOptions({}, { enabled: open, staleTime: STALE }));
  const boards = useQuery(trpc.boards.list.queryOptions({}, { enabled: open, staleTime: STALE }));
  const browsers = useAgentBrowsers({ enabled: open });
  return useMemo(
    () => selectPaletteRows(query, { sessions: sessions.data ?? [], boards: boards.data ?? [], browsers: browsers.data ?? [] },
      { kindWords: { board: L.palKindBoard, session: L.palKindSession, browser: L.palKindBrowser } }),
    [query, sessions.data, boards.data, browsers.data, L],
  );
}

function usePaletteTarget(onOpenChange: (open: boolean) => void) {
  const navigate = useNavigate();
  const { open: openSettings } = useSettings();
  const { setCurrentProject } = useCurrentProject();
  const { setSelectedSession } = useSelectedSession();
  const { openBoard, openAgentBrowser } = useDockIntake();
  return (row: PaletteRow) => {
    onOpenChange(false);
    if (row.modal === 'settings') return openSettings();
    if (row.browserSessionId) {
      // The session comes up beside its browser, so the chat the agent works in stays in view.
      navigate('/workbench');
      if (row.projectId) setCurrentProject(row.projectId);
      if (row.focusId) setSelectedSession(row.focusId);
      return openAgentBrowser(row.browserSessionId);
    }
    if (row.boardId) {
      // The dock lives on the workbench; the board opens there whichever page the palette was on.
      navigate('/workbench');
      return openBoard(row.boardId);
    }
    if (row.focusId) {
      if (row.projectId) setCurrentProject(row.projectId);
      setSelectedSession(row.focusId);
    }
    if (row.route) navigate(row.route);
  };
}

// The search row is the header: Escape, a click outside and the footer hint already say how to
// leave, so there is no separate close chip.
function PaletteHeader({ query, setQuery }: { query: string; setQuery: (value: string) => void }) {
  const L = useVocab();
  return (
    <div style={HEADER_STYLE}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--proto-muted)" strokeWidth="1.6"
        strokeLinecap="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
      </svg>
      <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder={L.cmdkPh} style={INPUT_STYLE} />
    </div>
  );
}

function PaletteResults({ rows, query, go }: { rows: PaletteRow[]; query: string; go: (row: PaletteRow) => void }) {
  const L = useVocab();
  return (
    <Command.List style={BODY_STYLE}>
      <Command.Empty style={EMPTY_STYLE}>{L.cpNoResults}</Command.Empty>
      {groupPaletteRows(rows).map((group, index) => (
        <Command.Group key={`${group.key}:${index}`} value={`${group.key}:${index}`}
          heading={<div style={GROUP_HEADING_STYLE}>{paletteGroupLabel(group.key, L)}</div>}>
          {group.rows.map((row) => <Row key={row.id} row={row} group={group.key} query={query} onSelect={() => go(row)} />)}
        </Command.Group>
      ))}
    </Command.List>
  );
}

function Keycap({ children }: { children: string }) {
  return <kbd style={KEYCAP_STYLE}>{children}</kbd>;
}

function PaletteFooter() {
  const L = useVocab();
  return (
    <div style={FOOTER_STYLE}>
      <span><Keycap>↑</Keycap><Keycap>↓</Keycap>{L.palKeyNavigate}</span>
      <span><Keycap>↵</Keycap>{L.palKeyOpen}</span>
      <span><Keycap>esc</Keycap>{L.palKeyClose}</span>
    </div>
  );
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const L = useVocab();
  const [query, setQuery] = useState('');
  useEffect(() => { if (open) setQuery(''); }, [open]);
  const rows = usePaletteRows(open, query);
  const go = usePaletteTarget(onOpenChange);
  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label={L.palLabel}
      shouldFilter={false} loop overlayClassName="cmdk-backdrop" contentClassName="cmdk-panel">
      <PaletteHeader query={query} setQuery={setQuery} />
      <PaletteResults rows={rows} query={query} go={go} />
      <PaletteFooter />
    </Command.Dialog>
  );
}
