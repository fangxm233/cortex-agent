import type { HistoryEvent, SessionHistory, SubagentEndStatus } from './conversation-history-repo.js';

export interface CompactConversationEvent extends HistoryEvent {
  elapsedMs: number | null;
}

export interface CompactSubagentSummary {
  id: string;
  type?: string;
  description?: string;
  model?: string;
  toolCount: number;
  hasDetails: boolean;
  structurallyOpen: boolean;
  /** Explicit lifecycle evidence; absent on legacy structural inferences. */
  status?: 'running' | SubagentEndStatus;
}

export interface CompactConversationHistory {
  sessionId: string;
  events: CompactConversationEvent[];
  committedSourceIds: string[];
  subagentSummaries: CompactSubagentSummary[];
  /** Server-internal, positionally aligned with `events`: the source row's revision. Present only
   *  when the caller supplied revisions; it is what lets a transcript read answer "since X". */
  eventRevs?: number[];
}

export interface SubagentConversationHistory {
  sessionId: string;
  subagentId: string;
  events: CompactConversationEvent[];
}

interface SummaryState extends CompactSubagentSummary {
  anchored: boolean;
}

interface CompactState {
  events: CompactConversationEvent[];
  eventRevs: number[];
  summaries: Map<string, SummaryState>;
  summaryOrder: string[];
  previousMs: number | null;
}

function isSpawnTool(toolName: string | null | undefined): boolean {
  return toolName === 'Agent' || toolName === 'Task' || toolName === 'agent';
}

function isLegacyAnchor(event: HistoryEvent): boolean {
  return event.type === 'tool' && !!event.subagentId && isSpawnTool(event.toolName);
}

function isStructuralSpawnTool(event: HistoryEvent): boolean {
  return event.type === 'tool' && !!event.subagentSpawns?.length && isSpawnTool(event.toolName);
}

function parseTs(ts: string): number | null {
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : null;
}

function elapsedMs(previousMs: number | null, ts: string): number | null {
  const currentMs = parseTs(ts);
  if (previousMs === null || currentMs === null) return null;
  return currentMs - previousMs;
}

function copyEvent(event: HistoryEvent, elapsed: number | null): CompactConversationEvent {
  return { ...event, elapsedMs: elapsed };
}

function createCompactState(): CompactState {
  return {
    events: [],
    eventRevs: [],
    summaries: new Map<string, SummaryState>(),
    summaryOrder: [],
    previousMs: null,
  };
}

function summaryFor(state: CompactState, id: string): SummaryState {
  const existing = state.summaries.get(id);
  if (existing) return existing;
  const summary: SummaryState = {
    id,
    toolCount: 0,
    hasDetails: false,
    structurallyOpen: false,
    anchored: false,
  };
  state.summaries.set(id, summary);
  state.summaryOrder.push(id);
  return summary;
}

function updateSummaryMetadata(summary: SummaryState, event: HistoryEvent): void {
  if (!summary.type && event.subagentType) summary.type = event.subagentType;
  if (!summary.description && event.subagentDescription) summary.description = event.subagentDescription;
  if (!summary.model && event.subagentModel) summary.model = event.subagentModel;
  if (!summary.description && isLegacyAnchor(event) && event.toolInput) summary.description = event.toolInput;
}

function updateSummaryFromSpawn(summary: SummaryState, spawn: NonNullable<HistoryEvent['subagentSpawns']>[number]): void {
  if (!summary.type && spawn.type) summary.type = spawn.type;
  if (!summary.description && spawn.description) summary.description = spawn.description;
}

/** Legacy orphan fallback only: a human turn closes unreported leftovers, not known live children.
 *  Runtime authority is overlaid at the query boundary, outside this pure cached projection.
 *  Synthetic user turns and main-agent output prove nothing about a background child's lifecycle. */
function consumeTurnBoundary(state: CompactState): void {
  for (const summary of state.summaries.values()) summary.structurallyOpen = false;
}

function openSpawnSummaries(state: CompactState, event: HistoryEvent): void {
  for (const spawn of event.subagentSpawns ?? []) {
    const summary = summaryFor(state, spawn.id);
    // Mixed-format anchors also carry a legacy prompt preview; prefer the explicit title.
    updateSummaryFromSpawn(summary, spawn);
    if (event.subagentId === spawn.id) updateSummaryMetadata(summary, event);
    summary.anchored = true;
    summary.structurallyOpen = true;
  }
}

function keepOrphanAnchor(state: CompactState, event: HistoryEvent): boolean {
  if (!event.subagentId || event.subagentSpawns?.length) return false;
  const summary = summaryFor(state, event.subagentId);
  if (summary.anchored) return false;
  summary.anchored = true;
  return true;
}

function keepCompactEvent(state: CompactState, event: HistoryEvent): boolean {
  if (!event.subagentId) return true;
  if (event.subagentSpawns?.length) return true;
  if (isLegacyAnchor(event)) return true;
  return keepOrphanAnchor(state, event);
}

function markDetail(summary: SummaryState, event: HistoryEvent): void {
  if (!event.subagentId || isLegacyAnchor(event) || isStructuralSpawnTool(event)) return;
  summary.hasDetails = true;
}

function consumeChildEvent(state: CompactState, event: HistoryEvent): void {
  const summary = summaryFor(state, event.subagentId!);
  updateSummaryMetadata(summary, event);
  summary.structurallyOpen = true;
  if (event.type === 'tool' && !isLegacyAnchor(event) && !isStructuralSpawnTool(event)) {
    summary.toolCount += 1;
  }
  markDetail(summary, event);
}

function pushCompactEvent(state: CompactState, event: HistoryEvent, elapsed: number | null, rev: number): void {
  state.events.push(copyEvent(event, elapsed));
  state.eventRevs.push(rev);
}

function consumeCompactEvent(state: CompactState, event: HistoryEvent, rev = 0): void {
  const elapsed = elapsedMs(state.previousMs, event.ts);
  state.previousMs = parseTs(event.ts);
  if (event.type === 'user' && !event.systemOrigin) consumeTurnBoundary(state);
  openSpawnSummaries(state, event);
  if (event.subagentId && !isStructuralSpawnTool(event)) consumeChildEvent(state, event);
  if (keepCompactEvent(state, event)) pushCompactEvent(state, event, elapsed, rev);
}

function summarize(state: CompactState): CompactSubagentSummary[] {
  return state.summaryOrder.map((id) => {
    const { anchored: _anchored, ...summary } = state.summaries.get(id)!;
    return summary;
  });
}

function detailEvent(event: HistoryEvent, elapsed: number | null): CompactConversationEvent {
  const { subagentSpawns: _spawns, ...rest } = event;
  return { ...rest, elapsedMs: elapsed };
}

function keepDetailEvent(event: HistoryEvent): boolean {
  return !isLegacyAnchor(event) && !isStructuralSpawnTool(event);
}

/** Apply the backend's own reported ends. Terminal and order-independent: a subagent reported
 *  `completed`/`failed`/`killed` is sealed no matter where its rows sit in the history. */
function sealReportedEnds(state: CompactState, history: SessionHistory): void {
  for (const end of history.subagentEnds ?? []) {
    const summary = state.summaries.get(end.id);
    if (!summary) continue;
    summary.structurallyOpen = false;
    summary.status = end.status;
  }
}

/**
 * Fold a parsed history into the compact read model. `sourceRevs` is positional against
 * `history.events`; supply it and the result carries the revision of each surviving row, which is
 * what a delta read compares against a client cursor.
 */
export function projectCompactHistory(
  history: SessionHistory,
  sourceRevs?: readonly number[],
): CompactConversationHistory {
  const state = createCompactState();
  history.events.forEach((event, index) => consumeCompactEvent(state, event, sourceRevs?.[index] ?? 0));
  sealReportedEnds(state, history);
  return {
    sessionId: history.sessionId,
    events: state.events,
    committedSourceIds: history.committedSourceIds ?? [],
    subagentSummaries: summarize(state),
    ...(sourceRevs ? { eventRevs: state.eventRevs } : {}),
  };
}

export function projectSubagentHistory(
  history: SessionHistory | null,
  subagentId: string,
): SubagentConversationHistory {
  const events: CompactConversationEvent[] = [];
  let previousMs: number | null = null;
  for (const event of history?.events ?? []) {
    const elapsed = elapsedMs(previousMs, event.ts);
    previousMs = parseTs(event.ts);
    if (event.subagentId !== subagentId || !keepDetailEvent(event)) continue;
    events.push(detailEvent(event, elapsed));
  }
  return { sessionId: history?.sessionId ?? '', subagentId, events };
}
