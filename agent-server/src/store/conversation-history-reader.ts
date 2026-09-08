// input:  persisted session JSONL and DEBUG warning policy
// output: collapsed history with tool device metadata
// pos:    Full and compact conversation-history parser
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createReadStream } from 'fs';
import { createInterface } from 'node:readline';
import { debugToolWarningChars, isDebugToolOverWarningThreshold } from '@core/debug-mode.js';
import type {
  HistoryDecisionItem,
  HistoryEvent,
  HistoryReadOptions,
  RawEvent,
  SessionHistory,
  SubagentEndStatus,
} from './conversation-history-repo.js';

interface ParseState {
  events: HistoryEvent[];
  committedSourceIds: Set<string>;
  subagentEnds: Map<string, SubagentEndStatus>;
  interactionById: Map<string, HistoryEvent>;
  decisionById: Map<string, HistoryDecisionItem>;
  toolByUseId: Map<string, HistoryEvent>;
  lastUser: HistoryEvent | null;
  turnIndex: number;
  pendingEdit: { originalText: string; originalTs: string } | null;
  includeToolDebug: boolean;
}

function createParseState(options: HistoryReadOptions): ParseState {
  return {
    events: [],
    committedSourceIds: new Set<string>(),
    subagentEnds: new Map<string, SubagentEndStatus>(),
    interactionById: new Map<string, HistoryEvent>(),
    decisionById: new Map<string, HistoryDecisionItem>(),
    toolByUseId: new Map<string, HistoryEvent>(),
    lastUser: null,
    turnIndex: -1,
    pendingEdit: null,
    includeToolDebug: options.includeToolDebug !== false,
  };
}

function isPrefixRelated(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

function debugResultToolRef(line: string): string | null {
  const encoded = /"toolUseId":"((?:\\.|[^"\\])*)"/.exec(line)?.[1];
  if (encoded === undefined) return null;
  try { return JSON.parse(`"${encoded}"`) as string; } catch { return null; }
}

function parseRawEvent(line: string): RawEvent | null {
  try { return JSON.parse(line) as RawEvent; } catch { return null; }
}

function subagentFields(ev: RawEvent) {
  if (!ev.subagentId) return {};
  return {
    subagentId: ev.subagentId,
    ...(ev.subagentType ? { subagentType: ev.subagentType } : {}),
    ...(ev.subagentDescription ? { subagentDescription: ev.subagentDescription } : {}),
    ...(ev.subagentModel ? { subagentModel: ev.subagentModel } : {}),
  };
}

function turnFor(state: ParseState): number {
  return Math.max(0, state.turnIndex);
}

function noteLargeToolResult(state: ParseState, line: string): boolean {
  if (state.includeToolDebug || !line.startsWith('{"type":"debug-tool-result"')) return false;
  const ref = debugResultToolRef(line);
  const tool = ref ? state.toolByUseId.get(ref) : undefined;
  if (tool && line.length > debugToolWarningChars()) {
    tool.debug = { ...(tool.debug ?? {}), overCharacterThreshold: true };
  }
  return true;
}

function consumeEditMarker(state: ParseState, ev: RawEvent): void {
  state.pendingEdit = { originalText: ev.originalText ?? '', originalTs: ev.originalTs ?? '' };
}

/** A `subagent-end` line: a state correction for one subagent's block, never a row. First report
 *  wins — a terminal state cannot be superseded. */
function consumeSubagentEnd(state: ParseState, ev: RawEvent): void {
  if (!ev.subagentId || !ev.subagentEnded) return;
  if (state.subagentEnds.has(ev.subagentId)) return;
  state.subagentEnds.set(ev.subagentId, ev.subagentEnded);
}

function consumeDebugPrompt(state: ParseState, ev: RawEvent): void {
  if (!state.lastUser || ev.agentMessage === undefined) return;
  state.lastUser.debug = { ...(state.lastUser.debug ?? {}), agentMessage: ev.agentMessage };
}

function consumeDebugToolResult(state: ParseState, ev: RawEvent): void {
  const tool = ev.toolUseId ? state.toolByUseId.get(ev.toolUseId) : undefined;
  if (!tool) return;
  tool.debug = {
    ...(tool.debug ?? {}),
    toolResult: { content: ev.text ?? '', isError: ev.isError === true },
  };
}

function pushUser(state: ParseState, ev: RawEvent): void {
  state.turnIndex += 1;
  if (ev.sourceId) state.committedSourceIds.add(ev.sourceId);
  const user: HistoryEvent = {
    type: 'user',
    text: ev.text ?? '',
    ts: ev.ts,
    turnIndex: state.turnIndex,
    attachments: ev.attachments,
    ...(state.pendingEdit ? { edited: state.pendingEdit } : {}),
    ...(ev.agentMessage !== undefined ? { debug: { agentMessage: ev.agentMessage } } : {}),
  };
  state.events.push(user);
  state.lastUser = user;
  state.pendingEdit = null;
}

function canCollapseAssistant(state: ParseState, ev: RawEvent): HistoryEvent | null {
  const last = state.events[state.events.length - 1];
  const text = ev.text ?? '';
  const hasAttachments = ev.attachments !== undefined;
  const hasDecisions = ev.decisions !== undefined && ev.decisions.length > 0;
  if (hasAttachments || hasDecisions || ev.noticeLevel !== undefined || !last) return null;
  if (last.type !== 'assistant' || last.noticeLevel !== undefined) return null;
  if (last.turnIndex !== turnFor(state) || last.attachments !== undefined || last.decisions !== undefined) return null;
  if (last.subagentId !== ev.subagentId || typeof last.text !== 'string') return null;
  return isPrefixRelated(last.text, text) ? last : null;
}

function pushAssistant(state: ParseState, ev: RawEvent): void {
  const existing = canCollapseAssistant(state, ev);
  const text = ev.text ?? '';
  if (existing) {
    if (text.length >= existing.text!.length) {
      existing.text = text;
      existing.ts = ev.ts;
    }
    return;
  }
  const decisions = ev.decisions?.length
    ? ev.decisions.map((decision): HistoryDecisionItem => ({ ...decision, actions: [] }))
    : undefined;
  state.events.push({
    type: 'assistant',
    text,
    ts: ev.ts,
    turnIndex: turnFor(state),
    ...(ev.attachments !== undefined ? { attachments: ev.attachments } : {}),
    ...(decisions ? { decisions } : {}),
    ...(ev.noticeLevel ? { noticeLevel: ev.noticeLevel } : {}),
    ...(ev.noticeAction ? { noticeAction: ev.noticeAction } : {}),
    ...(ev.subagentSpawns?.length ? { subagentSpawns: ev.subagentSpawns } : {}),
    ...subagentFields(ev),
  });
  for (const decision of decisions ?? []) state.decisionById.set(decision.id, decision);
}

function toolDebug(state: ParseState, ev: RawEvent) {
  const warned = !state.includeToolDebug && ev.fullInput !== undefined
    && isDebugToolOverWarningThreshold({ toolInput: ev.fullInput });
  if (!ev.toolUseId && !warned && (!state.includeToolDebug || ev.fullInput === undefined)) return undefined;
  return {
    ...(ev.toolUseId ? { toolRef: ev.toolUseId } : {}),
    ...(state.includeToolDebug && ev.fullInput !== undefined ? { toolInput: ev.fullInput } : {}),
    ...(warned ? { overCharacterThreshold: true as const } : {}),
  };
}

function pushTool(state: ParseState, ev: RawEvent): void {
  const debug = toolDebug(state, ev);
  const tool: HistoryEvent = {
    type: 'tool',
    toolName: ev.toolName ?? '',
    toolInput: ev.toolInput ?? '',
    ...(ev.toolDevice ? { toolDevice: ev.toolDevice } : {}),
    ts: ev.ts,
    turnIndex: turnFor(state),
    ...(debug ? { debug } : {}),
    ...(ev.subagentSpawns?.length ? { subagentSpawns: ev.subagentSpawns } : {}),
    ...subagentFields(ev),
  };
  state.events.push(tool);
  if (ev.toolUseId) state.toolByUseId.set(ev.toolUseId, tool);
}

function mergeResolvedInteraction(prior: HistoryEvent, ev: RawEvent): void {
  prior.status = ev.status;
  if (ev.result !== undefined) prior.result = ev.result;
  if (ev.resolvedVia !== undefined) prior.resolvedVia = ev.resolvedVia;
  prior.resolvedAt = ev.ts;
  if (ev.text) prior.text = ev.text;
}

function pushInteraction(state: ParseState, ev: RawEvent): void {
  if (!ev.id) {
    state.events.push({ type: 'interaction', subtype: ev.subtype, text: ev.text ?? '', ts: ev.ts, turnIndex: turnFor(state) });
    return;
  }
  const prior = state.interactionById.get(ev.id);
  if (prior && ev.status && ev.status !== 'pending') {
    mergeResolvedInteraction(prior, ev);
    return;
  }
  const interaction: HistoryEvent = {
    type: 'interaction',
    id: ev.id,
    kind: ev.kind,
    status: ev.status ?? 'pending',
    payload: ev.payload,
    result: ev.result,
    resolvedVia: ev.resolvedVia,
    text: ev.text ?? '',
    ts: ev.ts,
    turnIndex: turnFor(state),
  };
  state.events.push(interaction);
  state.interactionById.set(ev.id, interaction);
}

function consumeDecisionAction(state: ParseState, ev: RawEvent): void {
  const target = ev.decisionId ? state.decisionById.get(ev.decisionId) : undefined;
  if (!target || !ev.action) return;
  target.actions.push({
    action: ev.action,
    ...(ev.message !== undefined ? { message: ev.message } : {}),
    ts: ev.ts,
  });
}

function consumeParsedEvent(state: ParseState, ev: RawEvent): void {
  if (ev.type === 'edit-marker') return consumeEditMarker(state, ev);
  if (ev.type === 'subagent-end') return consumeSubagentEnd(state, ev);
  if (ev.type === 'decision-action') return consumeDecisionAction(state, ev);
  if (ev.type === 'debug-user-prompt') return consumeDebugPrompt(state, ev);
  if (ev.type === 'debug-tool-result') return consumeDebugToolResult(state, ev);
  if (ev.type === 'user') return pushUser(state, ev);
  if (ev.type === 'assistant') return pushAssistant(state, ev);
  if (ev.type === 'tool') return pushTool(state, ev);
  pushInteraction(state, ev);
}

function finishHistory(sessionId: string, state: ParseState): SessionHistory | null {
  if (state.events.length === 0) return null;
  return {
    sessionId,
    events: [...state.events],
    committedSourceIds: [...state.committedSourceIds],
    subagentEnds: [...state.subagentEnds].map(([id, status]) => ({ id, status })),
  };
}

async function consumeHistoryIterable(
  accumulator: ConversationHistoryAccumulator,
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<ConversationHistoryAccumulator> {
  for await (const line of lines) accumulator.consumeLine(line);
  return accumulator;
}

export class ConversationHistoryAccumulator {
  private readonly state: ParseState;

  constructor(
    private readonly sessionId: string,
    options: HistoryReadOptions = {},
  ) {
    this.state = createParseState(options);
  }

  consumeLine(line: string): void {
    if (!line.trim()) return;
    if (noteLargeToolResult(this.state, line)) return;
    const ev = parseRawEvent(line);
    if (ev) consumeParsedEvent(this.state, ev);
  }

  consumeRawEvent(ev: RawEvent, serializedLine?: string): void {
    const line = serializedLine === undefined
      ? JSON.stringify(ev)
      : serializedLine.endsWith('\n') ? serializedLine.slice(0, -1) : serializedLine;
    if (noteLargeToolResult(this.state, line)) return;
    consumeParsedEvent(this.state, ev);
  }

  snapshot(): SessionHistory | null {
    return finishHistory(this.sessionId, this.state);
  }
}

export async function parseHistoryText(
  sessionId: string,
  raw: string,
  options: HistoryReadOptions = {},
): Promise<SessionHistory | null> {
  const accumulator = new ConversationHistoryAccumulator(sessionId, options);
  await consumeHistoryIterable(accumulator, raw.split('\n'));
  return accumulator.snapshot();
}

export async function readHistoryAccumulator(
  sessionId: string,
  filePath: string,
  options: HistoryReadOptions = {},
): Promise<ConversationHistoryAccumulator> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const accumulator = new ConversationHistoryAccumulator(sessionId, options);
  try {
    return await consumeHistoryIterable(accumulator, lines);
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function readHistoryStream(
  sessionId: string,
  filePath: string,
  options: HistoryReadOptions = {},
): Promise<SessionHistory | null> {
  const accumulator = await readHistoryAccumulator(sessionId, filePath, options);
  return accumulator.snapshot();
}
