// input:  full SessionHistory snapshots with subagent attribution and spawn refs
// output: compact transcript projections, subagent summaries, and exact-id detail views
// pos:    Read-model reducer for lazy subagent transcript loading
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { HistoryEvent, SessionHistory } from './conversation-history-repo.js';

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
}

export interface CompactConversationHistory {
  sessionId: string;
  events: CompactConversationEvent[];
  committedSourceIds: string[];
  subagentSummaries: CompactSubagentSummary[];
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

function nextPreviousMs(ts: string): number | null {
  return parseTs(ts);
}

function copyEvent(event: HistoryEvent, elapsed: number | null): CompactConversationEvent {
  return { ...event, elapsedMs: elapsed };
}

function createCompactState(): CompactState {
  return {
    events: [],
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

function closeAllSummaries(state: CompactState): void {
  for (const summary of state.summaries.values()) summary.structurallyOpen = false;
}

function openSpawnSummaries(state: CompactState, event: HistoryEvent): void {
  for (const spawn of event.subagentSpawns ?? []) {
    const summary = summaryFor(state, spawn.id);
    if (event.subagentId === spawn.id) updateSummaryMetadata(summary, event);
    updateSummaryFromSpawn(summary, spawn);
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

function consumeMainEvent(state: CompactState): void {
  closeAllSummaries(state);
}

function pushCompactEvent(state: CompactState, event: HistoryEvent, elapsed: number | null): void {
  state.events.push(copyEvent(event, elapsed));
}

function consumeCompactEvent(state: CompactState, event: HistoryEvent): void {
  const elapsed = elapsedMs(state.previousMs, event.ts);
  state.previousMs = nextPreviousMs(event.ts);
  openSpawnSummaries(state, event);
  if (event.subagentId && !isStructuralSpawnTool(event)) consumeChildEvent(state, event);
  if (!event.subagentId && !isStructuralSpawnTool(event)) consumeMainEvent(state);
  if (keepCompactEvent(state, event)) pushCompactEvent(state, event, elapsed);
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

export function projectCompactHistory(history: SessionHistory): CompactConversationHistory {
  const state = createCompactState();
  for (const event of history.events) consumeCompactEvent(state, event);
  return {
    sessionId: history.sessionId,
    events: state.events,
    committedSourceIds: history.committedSourceIds ?? [],
    subagentSummaries: summarize(state),
  };
}

export function estimateCompactHistoryBytes(history: CompactConversationHistory | null): number {
  return history ? Buffer.byteLength(JSON.stringify(history), 'utf8') : 0;
}

export function projectSubagentHistory(
  history: SessionHistory | null,
  subagentId: string,
): SubagentConversationHistory {
  const events: CompactConversationEvent[] = [];
  let previousMs: number | null = null;
  for (const event of history?.events ?? []) {
    const elapsed = elapsedMs(previousMs, event.ts);
    previousMs = nextPreviousMs(event.ts);
    if (event.subagentId !== subagentId || !keepDetailEvent(event)) continue;
    events.push(detailEvent(event, elapsed));
  }
  return { sessionId: history?.sessionId ?? '', subagentId, events };
}
