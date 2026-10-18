import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';
import { shortSessionId } from '@/features/session/metadata/short-session-id';

// Pure mapping from the real tRPC query result (sessions.list) into the prototype's ⌘K flat-row
// item model (prototype.dc.html L1304–1311 + the `allCmdk` demo shape L2489–2499). Each row =
// label + sub + a kind tag that picks its group; page rows navigate via React Router and modal rows
// open in place. §8.3: the row structure is 1:1 with the prototype, real entities are the only variable.
// Sessions target their section route and carry the id in `focusId`.

export type PaletteModal = 'settings';

export interface CmdkItem {
  /** Unique cmdk `value` (stable, collision-free across kinds). */
  id: string;
  label: string;
  sub: string;
  /** Stable kind tag: `session` or `board` (groups the row, and matches a typed kind word). */
  kbd: string;
  route?: string;
  modal?: PaletteModal;
  focusId?: string;
  projectId: string;
  /** Board rows: the board to open in the dock. */
  boardId?: string;
  keywords: string[];
}

export interface CmdkSources {
  sessions: SessionInfo[];
  /** Already ordered: most recently updated first. */
  boards?: BoardInfo[];
}

export interface CmdkCommand {
  id: string;
  label: string;
  sub: string;
  kbd: string;
  route?: string;
  modal?: PaletteModal;
  keywords: string[];
  /** Vocab key resolved to the localized label at the render site (nav rows only). */
  labelKey: keyof Vocab;
  /** Vocab key resolved to the localized sub at the render site (nav rows only). */
  subKey: keyof Vocab;
}

// A rendered palette row — nav command or entity, unified for display + selection.
// `label`/`sub` carry the English fallback (also used for the substring filter); when
// `labelKey`/`subKey` are present (nav rows) the render site shows the localized string.
export interface PaletteRow {
  id: string;
  label: string;
  sub: string;
  kbd: string;
  route?: string;
  modal?: PaletteModal;
  focusId?: string;
  projectId?: string;
  boardId?: string;
  keywords: string[];
  labelKey?: keyof Vocab;
  subKey?: keyof Vocab;
}

export interface SelectOptions {
  /** Max entity rows per kind shown when the query is empty (keeps the DOM small). */
  restPerKind?: number;
  /** Max boards shown when the query is empty. */
  recentBoards?: number;
  /** Max total rows shown while searching. */
  matchCap?: number;
  /** Localized kind words by tag, so typing a kind's name lists that kind. */
  kindWords?: Record<string, string>;
}

// Non-empty tokens only — cmdk keyword matching ignores empties but keep the list clean.
function tokens(...parts: (string | null | undefined)[]): string[] {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

function sessionItem(s: SessionInfo): CmdkItem {
  return {
    // Match the rail's label/short-ID title while indexing the full ID for search.
    id: `session:${s.sessionId}`, label: s.label || shortSessionId(s.sessionId),
    sub: s.projectId, kbd: 'session', route: '/workbench', focusId: s.sessionId, projectId: s.projectId,
    keywords: tokens(s.sessionId, s.label, s.projectId, s.backend, s.kind),
  };
}

function boardItem(b: BoardInfo): CmdkItem {
  return {
    id: `board:${b.id}`, label: b.title || b.slug, sub: b.projectId, kbd: 'board', route: '/workbench',
    projectId: b.projectId, boardId: b.id,
    keywords: tokens(b.slug, b.projectId),
  };
}

export function buildCmdkItems({ sessions, boards = [] }: CmdkSources): CmdkItem[] {
  return [...boards.map(boardItem), ...sessions.map(sessionItem)];
}

// Static navigation command rows (prototype OV/ST legs + section jumps). The prototype also lists
// Approvals + New schedule, but those commands remain deferred here. Settings is an in-place modal
// target rather than a route; its sub-copy is verbatim from the prototype (L2496).
export const NAV_COMMAND_ITEMS: CmdkCommand[] = [
  {
    id: 'nav:overview',
    label: 'Overview',
    labelKey: 'overview',
    sub: 'project dashboard',
    subKey: 'cpSubOverview',
    kbd: 'page',
    route: '/overview',
    keywords: ['dashboard'],
  },
  {
    id: 'nav:workbench',
    label: 'Workbench',
    labelKey: 'workbench',
    sub: 'session chat',
    subKey: 'cpSubWorkbench',
    kbd: 'page',
    route: '/workbench',
    keywords: ['home', 'chat'],
  },
  {
    id: 'nav:settings',
    label: 'Settings',
    labelKey: 'settings',
    sub: 'platform · models · budget · machines…',
    subKey: 'cpSubSettings',
    kbd: 'modal',
    modal: 'settings',
    keywords: ['config'],
  },
];

// Prototype substring filter (prototype.dc.html L2498: `(label+' '+sub).indexOf(q)`), extended to
// keywords so an id/status also matches. We do the filtering ourselves (cmdk `shouldFilter={false}`)
// so we can CAP the rendered rows — feeding cmdk hundreds of real entities blows up the DOM and
// stalls the shared httpBatchLink fetch. Empty query → nav commands + a few recent entities per
// kind, the most recent boards first (proto-shot shows a short populated list); typing → all
// matches (nav + entities), capped.
export function selectPaletteRows(
  query: string,
  sources: CmdkSources,
  opts: SelectOptions = {},
): PaletteRow[] {
  const restPerKind = opts.restPerKind ?? 5;
  const recentBoards = opts.recentBoards ?? 8;
  const matchCap = opts.matchCap ?? 50;
  const nav: PaletteRow[] = NAV_COMMAND_ITEMS;
  const entities = buildCmdkItems(sources);
  const q = query.trim().toLowerCase();

  if (!q) {
    const byKind = (kbd: string) => entities.filter((e) => e.kbd === kbd);
    return [...nav, ...byKind('board').slice(0, recentBoards), ...byKind('session').slice(0, restPerKind)];
  }

  const kindWords = opts.kindWords ?? {};
  const matches = (r: PaletteRow) =>
    [r.label, r.sub, ...r.keywords, r.labelKey ? '' : r.kbd, r.labelKey ? '' : kindWords[r.kbd] ?? '']
      .join(' ').toLowerCase().includes(q);
  return [...nav, ...entities].filter(matches).slice(0, matchCap);
}

// ── Groups ───────────────────────────────────────────────────────────────────
// The list reads as a few headed groups instead of a column of kind tags. A group is a run of rows
// that share a kind, in the order `selectPaletteRows` already chose — so ↑/↓ walks the list exactly
// as before; the headings only name what each run is. Nav rows split by target: a route is a page,
// an in-place modal (settings) is an action.

export type PaletteGroupKey = 'page' | 'action' | 'board' | 'session';

export interface PaletteGroup {
  key: PaletteGroupKey | string;
  rows: PaletteRow[];
}

export function paletteGroupKey(row: PaletteRow): PaletteGroupKey | string {
  if (row.labelKey) return row.modal ? 'action' : 'page';
  return row.kbd;
}

/** Consecutive rows of one kind become one group; order is preserved. */
export function groupPaletteRows(rows: PaletteRow[]): PaletteGroup[] {
  const groups: PaletteGroup[] = [];
  for (const row of rows) {
    const key = paletteGroupKey(row);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  return groups;
}

/** The group heading in the UI language; an unknown kind shows as-is. */
export function paletteGroupLabel(
  key: string,
  L: Pick<Vocab, 'palGroupPage' | 'palGroupAction' | 'palGroupBoard' | 'palGroupSession'>,
): string {
  const labels: Record<string, string> = {
    page: L.palGroupPage, action: L.palGroupAction, board: L.palGroupBoard, session: L.palGroupSession,
  };
  return labels[key] ?? key;
}
