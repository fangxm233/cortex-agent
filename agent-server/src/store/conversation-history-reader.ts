import { createReadStream } from 'fs';
import { isOverDebugToolWarningChars } from '@core/debug-mode.js';
import type {
  HistoryDecisionItem,
  HistoryEvent,
  HistoryReadOptions,
  RawEvent,
  SessionHistory,
  SubagentEndStatus,
} from './conversation-history-repo.js';

/**
 * Folding a line can create a row OR reach back and change one that already exists (a streaming
 * assistant partial collapses into the previous row; a resolved interaction merges into its
 * `created` row; a decision action lands inside an assistant row). Anything that reaches back is
 * addressed by INDEX rather than by object reference, so the fold can stamp the revision of the
 * row it touched — that stamp is what lets a reader ask "what changed since?" without diffing.
 */
interface ParseState {
  events: HistoryEvent[];
  /** Parallel to `events`: the revision at which each row was last created or mutated. */
  revs: number[];
  /** Monotonic, bumped by every line that changes anything the read model can observe. */
  revision: number;
  committedSourceIds: Set<string>;
  subagentEnds: Map<string, SubagentEndStatus>;
  interactionById: Map<string, number>;
  decisionById: Map<string, { index: number; decision: HistoryDecisionItem }>;
  toolByUseId: Map<string, number>;
  lastUser: number | null;
  turnIndex: number;
  pendingEdit: { originalText: string; originalTs: string } | null;
  includeToolDebug: boolean;
}

function createParseState(options: HistoryReadOptions): ParseState {
  return {
    events: [],
    revs: [],
    revision: 0,
    committedSourceIds: new Set<string>(),
    subagentEnds: new Map<string, SubagentEndStatus>(),
    interactionById: new Map<string, number>(),
    decisionById: new Map<string, { index: number; decision: HistoryDecisionItem }>(),
    toolByUseId: new Map<string, number>(),
    lastUser: null,
    turnIndex: -1,
    pendingEdit: null,
    includeToolDebug: options.includeToolDebug !== false,
  };
}

/** Append a row and stamp it with a fresh revision. Returns the row's index. */
function pushEvent(state: ParseState, event: HistoryEvent): number {
  state.events.push(event);
  state.revs.push(++state.revision);
  return state.events.length - 1;
}

/** Re-stamp a row that an already-folded line reached back and changed. */
function touchEvent(state: ParseState, index: number): void {
  if (index < 0 || index >= state.revs.length) return;
  state.revs[index] = ++state.revision;
}

/** Record a change that belongs to the model as a whole rather than to one row
 *  (subagent ends, committed source ids) — the projection is derived, so it must re-run. */
function touchModel(state: ParseState): void {
  state.revision += 1;
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
  const index = ref ? state.toolByUseId.get(ref) : undefined;
  const tool = index === undefined ? undefined : state.events[index];
  if (tool && isOverDebugToolWarningChars(line.length)) {
    tool.debug = { ...(tool.debug ?? {}), overCharacterThreshold: true };
    touchEvent(state, index!);
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
  touchModel(state);
}

function consumeDebugPrompt(state: ParseState, ev: RawEvent): void {
  if (state.lastUser === null || ev.agentMessage === undefined) return;
  const user = state.events[state.lastUser];
  user.debug = { ...(user.debug ?? {}), agentMessage: ev.agentMessage };
  touchEvent(state, state.lastUser);
}

function consumeDebugToolResult(state: ParseState, ev: RawEvent): void {
  const index = ev.toolUseId ? state.toolByUseId.get(ev.toolUseId) : undefined;
  if (index === undefined) return;
  const tool = state.events[index];
  tool.debug = {
    ...(tool.debug ?? {}),
    toolResult: { content: ev.text ?? '', isError: ev.isError === true },
  };
  touchEvent(state, index);
}

function pushUser(state: ParseState, ev: RawEvent): void {
  state.turnIndex += 1;
  if (ev.sourceId) {
    state.committedSourceIds.add(ev.sourceId);
    touchModel(state);
  }
  const user: HistoryEvent = {
    type: 'user',
    text: ev.text ?? '',
    ts: ev.ts,
    turnIndex: state.turnIndex,
    attachments: ev.attachments,
    ...(ev.systemOrigin !== undefined ? { systemOrigin: ev.systemOrigin } : {}),
    ...(state.pendingEdit ? { edited: state.pendingEdit } : {}),
    ...(ev.agentMessage !== undefined ? { debug: { agentMessage: ev.agentMessage } } : {}),
  };
  state.lastUser = pushEvent(state, user);
  state.pendingEdit = null;
}

function canCollapseAssistant(state: ParseState, ev: RawEvent): number | null {
  const index = state.events.length - 1;
  const last = state.events[index];
  const text = ev.text ?? '';
  const hasAttachments = ev.attachments !== undefined;
  const hasDecisions = ev.decisions !== undefined && ev.decisions.length > 0;
  if (hasAttachments || hasDecisions || ev.noticeLevel !== undefined || !last) return null;
  if (last.type !== 'assistant' || last.noticeLevel !== undefined) return null;
  if (last.turnIndex !== turnFor(state) || last.attachments !== undefined || last.decisions !== undefined) return null;
  if (last.subagentId !== ev.subagentId || typeof last.text !== 'string') return null;
  return isPrefixRelated(last.text, text) ? index : null;
}

function pushAssistant(state: ParseState, ev: RawEvent): void {
  const collapseInto = canCollapseAssistant(state, ev);
  const text = ev.text ?? '';
  if (collapseInto !== null) {
    const existing = state.events[collapseInto];
    if (text.length >= existing.text!.length) {
      existing.text = text;
      existing.ts = ev.ts;
      touchEvent(state, collapseInto);
    }
    return;
  }
  const decisions = ev.decisions?.length
    ? ev.decisions.map((decision): HistoryDecisionItem => ({ ...decision, actions: [] }))
    : undefined;
  const index = pushEvent(state, {
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
  for (const decision of decisions ?? []) state.decisionById.set(decision.id, { index, decision });
}

/** `chars` is the length of the JSON line this event was parsed from — see
 *  `isOverDebugToolWarningChars`. The verdict is stamped on DEBUG and plain reads alike: the fold
 *  is the only place that still holds the row's own bytes, so stamping here is what lets every
 *  reader downstream trust the flag instead of re-deriving it from the parsed input. */
function toolDebug(state: ParseState, ev: RawEvent, chars: number) {
  const warned = ev.fullInput !== undefined && isOverDebugToolWarningChars(chars);
  if (!ev.toolUseId && !warned && (!state.includeToolDebug || ev.fullInput === undefined)) return undefined;
  return {
    ...(ev.toolUseId ? { toolRef: ev.toolUseId } : {}),
    ...(state.includeToolDebug && ev.fullInput !== undefined ? { toolInput: ev.fullInput } : {}),
    ...(warned ? { overCharacterThreshold: true as const } : {}),
  };
}

function pushTool(state: ParseState, ev: RawEvent, chars: number): void {
  const debug = toolDebug(state, ev, chars);
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
  const index = pushEvent(state, tool);
  if (ev.toolUseId) state.toolByUseId.set(ev.toolUseId, index);
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
    pushEvent(state, { type: 'interaction', subtype: ev.subtype, text: ev.text ?? '', ts: ev.ts, turnIndex: turnFor(state) });
    return;
  }
  const priorIndex = state.interactionById.get(ev.id);
  if (priorIndex !== undefined && ev.status && ev.status !== 'pending') {
    mergeResolvedInteraction(state.events[priorIndex], ev);
    touchEvent(state, priorIndex);
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
  state.interactionById.set(ev.id, pushEvent(state, interaction));
}

function consumeDecisionAction(state: ParseState, ev: RawEvent): void {
  const target = ev.decisionId ? state.decisionById.get(ev.decisionId) : undefined;
  if (!target || !ev.action) return;
  target.decision.actions.push({
    action: ev.action,
    ...(ev.message !== undefined ? { message: ev.message } : {}),
    ts: ev.ts,
  });
  touchEvent(state, target.index);
}

function consumeParsedEvent(state: ParseState, ev: RawEvent, chars: number): void {
  if (ev.type === 'edit-marker') return consumeEditMarker(state, ev);
  if (ev.type === 'subagent-end') return consumeSubagentEnd(state, ev);
  if (ev.type === 'decision-action') return consumeDecisionAction(state, ev);
  if (ev.type === 'debug-user-prompt') return consumeDebugPrompt(state, ev);
  if (ev.type === 'debug-tool-result') return consumeDebugToolResult(state, ev);
  if (ev.type === 'user') return pushUser(state, ev);
  if (ev.type === 'assistant') return pushAssistant(state, ev);
  if (ev.type === 'tool') return pushTool(state, ev, chars);
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

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * Fold a JSONL file into `accumulator`, starting at its byte cursor, and stop at the last COMPLETE
 * line. Deliberately byte-level rather than `readline`:
 *
 *  - The cursor has to be exact. It is what makes the next read resume instead of re-parsing the
 *    whole file, and `readline` reports lines, not byte offsets.
 *  - A concurrent append can be observed half-written (a multi-megabyte tool result is not one
 *    atomic write). `readline` would hand that fragment over as if it were a line and the cursor
 *    would step past it, losing the row for good. Stopping at the last newline leaves the fragment
 *    for the next read, which sees it whole.
 *
 * Splitting on the newline BYTE is safe for UTF-8: 0x0A cannot occur inside a multi-byte sequence.
 */
async function foldFileInto(
  accumulator: ConversationHistoryAccumulator,
  filePath: string,
  start: number,
): Promise<void> {
  const stream = createReadStream(filePath, { start });
  /** Pieces of a line whose newline has not arrived yet, kept UNJOINED until it does. Re-joining
   *  the tail onto every chunk instead is quadratic in the line's length, and a row here is a whole
   *  tool result: the largest in this store is 43MB, which that shape folds in 3.6 minutes against
   *  1.8 seconds for one join at the end. Rows are joined once, when their newline lands. */
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let consumed = start;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let from = 0;
      for (;;) {
        // Only the new chunk is searched: everything before it has already been scanned.
        const nl = chunk.indexOf(NEWLINE, from);
        if (nl < 0) break;
        let line: Buffer;
        if (pendingBytes > 0) {
          pending.push(chunk.subarray(from, nl));
          line = Buffer.concat(pending, pendingBytes + (nl - from));
          pending = [];
          pendingBytes = 0;
        } else {
          line = chunk.subarray(from, nl);
        }
        consumed += line.length + 1;
        const end = line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN
          ? line.length - 1 : line.length; // tolerate CRLF
        accumulator.consumeLine(line.toString('utf8', 0, end));
        from = nl + 1;
      }
      if (from < chunk.length) {
        const tail = chunk.subarray(from);
        pending.push(tail);
        pendingBytes += tail.length;
      }
    }
  } finally {
    accumulator.advanceCursor(consumed);
    stream.destroy();
  }
}

export class ConversationHistoryAccumulator {
  private readonly state: ParseState;
  /** Byte offset of the first byte of the file NOT yet folded in. */
  private cursor = 0;

  constructor(
    private readonly sessionId: string,
    options: HistoryReadOptions = {},
  ) {
    this.state = createParseState(options);
  }

  /** Bytes of the source file already folded in — where a resumed read starts. */
  get bytesConsumed(): number {
    return this.cursor;
  }

  /** Monotonic revision of the folded model. Unchanged between two reads means nothing to redo. */
  get revision(): number {
    return this.state.revision;
  }

  /** Rows folded so far. Zero means the file held nothing a transcript can show. */
  get eventCount(): number {
    return this.state.events.length;
  }

  /** @internal Advanced by the file fold; never rewound. */
  advanceCursor(bytes: number): void {
    if (bytes > this.cursor) this.cursor = bytes;
  }

  consumeLine(line: string): void {
    if (!line.trim()) return;
    if (noteLargeToolResult(this.state, line)) return;
    const ev = parseRawEvent(line);
    if (ev) consumeParsedEvent(this.state, ev, line.length);
  }

  consumeRawEvent(ev: RawEvent, serializedLine?: string): void {
    const line = serializedLine === undefined
      ? JSON.stringify(ev)
      : serializedLine.endsWith('\n') ? serializedLine.slice(0, -1) : serializedLine;
    if (noteLargeToolResult(this.state, line)) return;
    consumeParsedEvent(this.state, ev, line.length);
  }

  snapshot(): SessionHistory | null {
    return finishHistory(this.sessionId, this.state);
  }

  /** Per-row revisions, positionally aligned with `snapshot().events`. Live array — read only. */
  eventRevisions(): readonly number[] {
    return this.state.revs;
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
  const accumulator = new ConversationHistoryAccumulator(sessionId, options);
  await foldFileInto(accumulator, filePath, 0);
  return accumulator;
}

/**
 * Fold whatever the file has gained since this accumulator last read it. The file is append-only
 * between rewrites, so a partially-read fold is a valid PREFIX state, not a spoiled one — resuming
 * from the cursor is what turns a refresh from "re-parse the session" into "parse the new bytes".
 * A rewrite (rewind / clear) is not resumable and is handled by the caller dropping the model.
 */
export async function resumeHistoryAccumulator(
  accumulator: ConversationHistoryAccumulator,
  filePath: string,
): Promise<ConversationHistoryAccumulator> {
  await foldFileInto(accumulator, filePath, accumulator.bytesConsumed);
  return accumulator;
}

export async function readHistoryStream(
  sessionId: string,
  filePath: string,
  options: HistoryReadOptions = {},
): Promise<SessionHistory | null> {
  const accumulator = await readHistoryAccumulator(sessionId, filePath, options);
  return accumulator.snapshot();
}
