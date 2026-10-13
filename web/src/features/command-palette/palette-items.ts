import type { SessionInfo } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

// Pure mapping from the real tRPC query result (sessions.list) into the prototype's ⌘K flat-row
// item model (prototype.dc.html L1304–1311 + the `allCmdk` demo shape L2489–2499). Each row =
// label + sub + right-aligned kbd tag; page rows navigate via React Router and modal rows open in
// place. §8.3: the row structure is 1:1 with the prototype, real entities are the only variable.
// Sessions target their section route and carry the id in `focusId`.

export type PaletteModal = 'settings';

export interface CmdkItem {
  /** Unique cmdk `value` (stable, collision-free across kinds). */
  id: string;
  label: string;
  sub: string;
  /** Right-aligned mono type tag — currently always `session`. */
  kbd: string;
  route?: string;
  modal?: PaletteModal;
  focusId: string;
  projectId: string;
  keywords: string[];
}

export interface CmdkSources {
  sessions: SessionInfo[];
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
  keywords: string[];
  labelKey?: keyof Vocab;
  subKey?: keyof Vocab;
}

export interface SelectOptions {
  /** Max entity rows per kind shown when the query is empty (keeps the DOM small). */
  restPerKind?: number;
  /** Max total rows shown while searching. */
  matchCap?: number;
}

// Non-empty tokens only — cmdk keyword matching ignores empties but keep the list clean.
function tokens(...parts: (string | null | undefined)[]): string[] {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

function sessionItem(s: SessionInfo): CmdkItem {
  return {
    // Same title the rail shows (rail-tree sessionTitle): the user-set `label` wins over the
    // generated `name`, so a session found here is not called something else in the tree.
    id: `session:${s.sessionId}`, label: s.label || s.name || s.sessionId,
    sub: s.projectId, kbd: 'session', route: '/workbench', focusId: s.sessionId, projectId: s.projectId,
    keywords: tokens(s.sessionId, s.name, s.label, s.projectId, s.backend, s.kind),
  };
}

export function buildCmdkItems({ sessions }: CmdkSources): CmdkItem[] {
  return sessions.map(sessionItem);
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
    sub: 'platform · profiles · budget · machines…',
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
// kind (proto-shot shows a short populated list); typing → all matches (nav + entities), capped.
export function selectPaletteRows(
  query: string,
  sources: CmdkSources,
  opts: SelectOptions = {},
): PaletteRow[] {
  const restPerKind = opts.restPerKind ?? 5;
  const matchCap = opts.matchCap ?? 50;
  const nav: PaletteRow[] = NAV_COMMAND_ITEMS;
  const entities = buildCmdkItems(sources);
  const q = query.trim().toLowerCase();

  if (!q) {
    const byKind = (kbd: string) => entities.filter((e) => e.kbd === kbd).slice(0, restPerKind);
    return [...nav, ...byKind('session')];
  }

  const matches = (r: PaletteRow) =>
    (r.label + ' ' + r.sub + ' ' + r.keywords.join(' ')).toLowerCase().includes(q);
  return [...nav, ...entities].filter(matches).slice(0, matchCap);
}

/** The localized kind tag (`PaletteRow.kbd` stays the stable tag); an unknown tag shows as-is. */
export function paletteKindText(
  kind: string,
  L: Pick<Vocab, 'palKindCommand' | 'palKindSession' | 'palKindPage' | 'palKindModal'>,
): string {
  const kinds: Record<string, string> = {
    command: L.palKindCommand, session: L.palKindSession, page: L.palKindPage, modal: L.palKindModal,
  };
  return kinds[kind] ?? kind;
}
