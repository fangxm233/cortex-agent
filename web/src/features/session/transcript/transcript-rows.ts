import type {
  SessionTranscript,
  TranscriptMessage,
  TranscriptSubagentSummary,
} from '@cortex-agent/ui-contract';
import { dayDivider, type TimeLang } from '@/i18n/time-format';
import type { ToolCallImage } from '@/features/session/composer/chat-content';
import type { ChatRow, DebugToolDetail, ToolCallEntry } from './chat-row';
import {
  liveToMessage,
  type LiveSessionMessage,
  type SubagentSpawnView,
  type TranscriptMessageWithSpawns,
} from './live-message';
import type { PendingUserMessage } from './pending-user';
import { boardActionOf } from './board-rows';
import {
  addWorkerUpdate, createTeamBuild, finishTeamRows, parseWorkerMessage, placeTeamAction, progressUpdate,
  teamActionOf, type TeamBuild,
} from './team-rows';

// Pure view-model for the workbench center-chat transcript (S4 chat, task aba0). Maps the real
// `sessions.transcript` DTO (+ a live `session.message` tail) into the prototype's exact message-row
// model (prototype.dc.html L145–356). Real data is the only variable — the render (MessageStream)
// owns every px/hex/font/copy; this module only decides which rows exist and what text they carry.
// It also says WHICH row is still being written (`preview` on the assistant row) — the one row whose
// text is still arriving, and therefore the only one the render paces.

export interface BuildOpts {
  /** True while the session is actively producing output — marks the last assistant row's caret. */
  streaming?: boolean;
  /**
   * Whether the session is genuinely executing (status snapshot + delta), which is what decides
   * if a legacy subagent block may still show as running. Explicit child status outranks it.
   * NOT the same as `streaming`: that one is a
   * 2.5s quiet-gap timer that drops between events mid-turn, so deriving the block's state from
   * it made the badge blink on and off for the whole run. Falls back to `streaming` when the
   * caller has no status of its own.
   */
  running?: boolean;
  /** Injected clock for deterministic day-relative divider labels (defaults to Date.now). */
  now?: Date;
  /**
   * Divider label for the first message ts of a day. Defaults to the English `capsDayDivider`.
   */
  formatDivider?: (ts: string, now: Date) => string;
  /**
   * Text accumulated for the assistant block currently being written (token-level streaming).
   * Rendered as one extra assistant row at the very end, flagged `streaming`. The row
   * disappears the moment the hook retires the preview, which is the same render pass in which the
   * complete message enters the live tail — so the text never flickers or doubles.
   */
  streamingText?: string | null;
  /**
   * Messages written into the running turn's backend but not yet read by the model. They render as
   * the LAST rows of the stream — below the streaming preview too — in send order among themselves,
   * flagged `pending`. Anything the agent says while they sit here was said without them, which is
   * why they are not merged into the ordered tail until the delivered event moves them there.
   */
  pendingUser?: PendingUserMessage[];
  /**
   * Scheduled sessions (origin 'scheduled' / adopted runs): strip the `[Scheduled Task]` payload
   * prefix off the FIRST user row — design 30c renders the fire prompt as a PLAIN user bubble
   * (the 27b trigger card is retired). Replies and manual sessions are untouched.
   */
  stripScheduledPrefix?: boolean;
}

const SCHEDULED_PREFIX = '[Scheduled Task]';

const REMOTE_TOOL_NAMES = new Set([
  'remote_bash', 'remote_read', 'remote_write',
  'remote_edit', 'remote_glob', 'remote_grep',
]);

/** Compact device-qualified label for remote transcript tools. */
export function toolCallLabel(toolName: string, device?: string): string {
  const rawName = toolName.split('__').at(-1)?.split('.').at(-1) ?? toolName;
  if (!device || !REMOTE_TOOL_NAMES.has(rawName)) return toolName;
  return `${rawName.slice('remote_'.length)}:${device}`;
}

/** A sink collects rows plus its own pending run of consecutive tool calls. The top level has one;
 *  each open subagent block has one. */
interface RowSink {
  rows: ChatRow[];
  toolBuf: ToolCallEntry[];
}

/** Tools whose input is the path of the file they read. */
const FILE_READ_TOOLS = new Set(['Read', 'read', 'remote_read']);

/** The file a read call named, when its input is a path; null for every other call, and for a path
 *  the server cut short. */
function readFileName(toolName: string | null | undefined, input: string | null | undefined): string | null {
  const bare = toolName?.split('__').at(-1)?.split('.').at(-1) ?? '';
  if (!FILE_READ_TOOLS.has(bare) || !input || input.endsWith('…')) return null;
  const base = input.split(/[\\/]/).at(-1) ?? '';
  return /.\.[A-Za-z0-9]+$/.test(base) ? base : null;
}

/** The image attachments a tool row's result carried, as the row renders them. A read call's image
 *  goes by the file it read; anything else keeps the stored name. */
function toolCallImages(m: TranscriptMessage): ToolCallImage[] | undefined {
  const fileName = readFileName(m.toolName, m.toolInput);
  const images = m.attachments?.filter((a) => a.type === 'image')
    .map((a) => ({ name: fileName ?? a.name, path: a.path }));
  return images?.length ? images : undefined;
}

/** Both spellings ship: `Agent` in current backends, `Task` historically and in session JSONL. */
function isSubagentSpawnTool(toolName: string | null | undefined): boolean {
  return toolName === 'Agent' || toolName === 'Task' || toolName === 'agent';
}

function msgKey(m: TranscriptMessageWithSpawns): string {
  // Interaction entities have a stable id — key on it so a status change (pending → approved)
  // REPLACES the row instead of duplicating it.
  if (m.type === 'interaction' && m.interaction?.id) return `interaction|${m.interaction.id}`;
  const noticeId = m.authAction?.noticeId ?? '';
  const spawnIds = m.subagentSpawns?.map((spawn) => spawn.id).join(',') ?? '';
  // Decision ids only — NOT the action logs: a refetched row with new actions must dedupe against
  // the live-tail original (the transcript version is pushed first and wins).
  const decisionIds = m.decisions?.map((d) => d.id).join(',') ?? '';
  // A reported subagent end carries no text of its own, so two children settling in the same
  // millisecond would otherwise share one key and the second block would never be sealed. Keyed on
  // the block it seals; appended rather than folded in, so every ordinary row keeps its old key.
  const end = m.subagentEnded ? `${m.subagentEnded}|${m.subagentId ?? ''}` : '';
  return `${m.type}|${m.ts}|${m.text ?? ''}|${m.toolName ?? ''}|${m.toolInput ?? ''}|${m.toolDevice ?? ''}|${spawnIds}|${m.noticeLevel ?? ''}|${noticeId}|${decisionIds}|${end}`;
}

/** The desktop divider: the shared day divider in caps — `TODAY 09:05` / `SEP 24 09:05` / `9月24日 09:05`. */
export function capsDayDivider(lang: TimeLang): (ts: string, now: Date) => string {
  return (ts, now) => dayDivider(ts, now, lang).toUpperCase();
}

const defaultDivider = capsDayDivider('en');

/**
 * Send-time stamp for a single message, as revealed on desktop hover / mobile long-press. `HH:MM`
 * while the message is from today; `MM-DD HH:MM` on any other day; `YYYY-MM-DD HH:MM` once the year
 * differs. The day dividers already date each run of messages, so the common case stays a bare
 * clock — the date only appears where a reader scrolled back far enough to have lost the divider.
 * Returns null for a missing or unparseable ts so the caller can skip the affordance entirely.
 */
export function messageTimeLabel(ts: string | undefined, now: Date = new Date()): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return `${d.getFullYear() === now.getFullYear() ? date : `${d.getFullYear()}-${date}`} ${time}`;
}

function dayStamp(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

type FlatMessage = TranscriptMessageWithSpawns & { turnIndex?: number };

interface SubagentBlockState {
  row: Extract<ChatRow, { kind: 'subagent' }>;
  sink: RowSink;
  summary?: TranscriptSubagentSummary;
  /** The backend reported this subagent terminal. Outranks every structural inference below:
   *  a later main-agent row cannot reopen it, and it cannot be left running at the end. */
  ended?: boolean;
  /** This block has live-tail rows the fetched transcript does not contain yet, i.e. the
   *  subagent produced output the summary snapshot predates. Keeps a stale summary from
   *  reporting "done" for a subagent that is demonstrably still working. */
  liveOpen?: boolean;
}

// Rows land in a sink, not straight into `rows`: a native subagent's output goes into its own
// block's `children` instead of the top level. Each sink buffers its own consecutive tool calls,
// so a subagent's tools collapse among themselves and never merge with the main agent's.
interface BuildState {
  rows: ChatRow[];
  top: RowSink;
  blocks: Map<string, SubagentBlockState>;
  summaries: Map<string, TranscriptSubagentSummary>;
  summaryAuthority: boolean;
  /** Ends are order-independent, including an end arriving before its anchor or late output. */
  reportedEnds: Set<string>;
  team: TeamBuild;
}

/** The transcript, then the live tail, deduplicated by message key. */
function flattenMessages(transcript: SessionTranscript, liveTail: LiveSessionMessage[]): FlatMessage[] {
  const flat: FlatMessage[] = [];
  const seen = new Set<string>();
  const push = (m: TranscriptMessageWithSpawns, turnIndex?: number): void => {
    const k = msgKey(m);
    if (seen.has(k)) return;
    seen.add(k);
    flat.push(turnIndex !== undefined ? { ...m, turnIndex } : m);
  };
  for (const turn of transcript.turns) {
    for (const m of turn.messages) push(m, turn.turnIndex);
  }
  for (const lm of liveTail) push({ ...liveToMessage(lm), liveTail: true });
  return flat;
}

function createBuildState(transcript: SessionTranscript, flat: FlatMessage[]): BuildState {
  const rows: ChatRow[] = [];
  const summaries = new Map<string, TranscriptSubagentSummary>();
  for (const summary of transcript.subagentSummaries ?? []) summaries.set(summary.id, summary);
  return {
    rows,
    top: { rows, toolBuf: [] },
    blocks: new Map(),
    summaries,
    summaryAuthority: transcript.subagentSummaries !== undefined,
    reportedEnds: new Set(flat.filter(m => m.subagentEnded && m.subagentId).map(m => m.subagentId!)),
    team: createTeamBuild(),
  };
}

/**
 * A run of consecutive calls becomes rows in call order: adjacent calls whose result carried
 * images share one row, adjacent other calls share another, so reads and tools alternate as they ran.
 */
function flushTools(sink: RowSink): void {
  let calls: ToolCallEntry[] = [];
  for (const call of sink.toolBuf) {
    if (calls.length > 0 && !calls[0].images !== !call.images) {
      sink.rows.push({ kind: 'tools', count: calls.length, calls });
      calls = [];
    }
    calls.push(call);
  }
  if (calls.length > 0) sink.rows.push({ kind: 'tools', count: calls.length, calls });
  sink.toolBuf = [];
}

function flushAll(state: BuildState): void {
  flushTools(state.top);
  for (const b of state.blocks.values()) flushTools(b.sink);
}

/**
 * A batch of subagents is over the moment the main agent acts again — the model cannot speak or
 * call another tool until every Task it issued has returned. The spawning calls themselves are
 * excluded by the caller, since a second Task in the same batch must not close the first.
 *
 * That premise holds for a blocking batch and fails for a backgrounded one, which by design runs
 * ALONGSIDE the main agent. `liveOpen` is the evidence that separates them: rows the fetched
 * transcript does not have yet mean this child is demonstrably still working, whatever the main
 * agent just did. Such a block is left to the two authorities that can actually end it — the
 * backend's reported end, and the sweep for a session that is no longer live. The cost is a
 * native Task whose end went missing (a resume that lost its `task_started`) reading as running
 * until its turn is over, instead of until the next main-agent row.
 */
function closeBlocksTheMainAgentOutran(blocks: Map<string, SubagentBlockState>): void {
  for (const b of blocks.values()) {
    if (!b.ended && (b.summary?.status === 'running' || b.liveOpen)) continue;
    b.row.status = 'done';
  }
}

/** Parent-idle fallback for legacy blocks only; explicit child authority is applied below. */
function closeOpenBlocks(blocks: Map<string, SubagentBlockState>): void {
  for (const b of blocks.values()) b.row.status = 'done';
}

/**
 * A backgrounded subagent runs WHILE the main agent keeps working, so main-agent rows land
 * between its rows and `closeOpenBlocks` marks it done prematurely. Another row from the same
 * subagent proves it was still going; the block reopens rather than fragmenting into a second
 * one, and the last main-agent row after it genuinely ends leaves it done.
 */
function reopenBlock(existing: SubagentBlockState, m: FlatMessage, spawn?: SubagentSpawnView): void {
  if (!existing.ended) existing.row.status = 'running';
  if (m.liveTail) existing.liveOpen = true;
  if (!existing.summary) {
    // The anchor carries the description, the child rows carry the declared type — whichever
    // arrives second fills in what the first could not know.
    if (!existing.row.agentType && (m.subagentType || spawn?.type)) {
      existing.row.agentType = m.subagentType ?? spawn?.type ?? null;
    }
    if (m.subagentDescription) existing.row.description = m.subagentDescription;
    else if (!existing.row.description && spawn?.description) existing.row.description = spawn.description;
    if (!existing.row.model && m.subagentModel) existing.row.model = m.subagentModel;
  }
  if (!existing.row.prompt && spawn?.prompt) existing.row.prompt = spawn.prompt;
}

function subagentRow(
  state: BuildState,
  id: string,
  m: FlatMessage,
  spawn: SubagentSpawnView | undefined,
  ended: boolean,
): Extract<ChatRow, { kind: 'subagent' }> {
  const summary = state.summaries.get(id);
  return {
    kind: 'subagent',
    id,
    agentType: summary?.type ?? m.subagentType ?? spawn?.type ?? null,
    description: summary?.description ?? m.subagentDescription ?? spawn?.description ?? null,
    prompt: spawn?.prompt ?? null,
    model: summary?.model ?? m.subagentModel ?? null,
    status: ended ? 'done' : 'running',
    toolCount: summary?.toolCount ?? 0,
    children: [],
    ...(state.summaryAuthority && summary
      ? { hasDetails: summary.hasDetails, detailMode: 'lazy' as const }
      : {}),
  };
}

function openBlock(state: BuildState, m: FlatMessage, id: string, spawn?: SubagentSpawnView): SubagentBlockState {
  const existing = state.blocks.get(id);
  if (existing) {
    reopenBlock(existing, m, spawn);
    return existing;
  }
  flushTools(state.top);
  const summary = state.summaries.get(id);
  const ended = state.reportedEnds.has(id) || (!!summary?.status && summary.status !== 'running');
  const row = subagentRow(state, id, m, spawn, ended);
  state.rows.push(row);
  const entry: SubagentBlockState = {
    row, sink: { rows: row.children, toolBuf: [] }, summary,
    ended,
    ...(m.liveTail ? { liveOpen: true } : {}),
  };
  state.blocks.set(id, entry);
  return entry;
}

/**
 * Where a message's row goes: the top-level sink or its subagent block. Null when the message only
 * updates a block (a reported end, a spawning call, a summarized child) and adds no row of its own.
 */
function routeMessage(state: BuildState, m: FlatMessage): { sink: RowSink; block: SubagentBlockState | null } | null {
  // A backend-reported subagent end: a state correction, not a row. Seal the block and drop the
  // message — it carries no prose, and rendering it would add an empty line to the transcript.
  if (m.subagentEnded && m.subagentId) {
    const block = state.blocks.get(m.subagentId);
    if (block) {
      block.ended = true;
      block.row.status = 'done';
    }
    return null;
  }
  // New anchors describe one or more children explicitly. One PI `agent` call may represent a
  // parallel/chain batch, while Claude Agent/Task calls contain one child.
  if (m.subagentSpawns?.length) {
    for (const spawn of m.subagentSpawns) openBlock(state, m, spawn.id, spawn);
    if (m.type === 'tool' && isSubagentSpawnTool(m.toolName)) return null;
  }
  // Legacy histories overloaded `subagentId` onto the spawning call. Keep rendering them with
  // their compact summary, but never mistake that lossy fallback for a complete prompt.
  if (m.type === 'tool' && !!m.subagentId && isSubagentSpawnTool(m.toolName)) {
    const block = openBlock(state, m, m.subagentId);
    if (!block.summary && !block.row.description && m.toolInput) block.row.description = m.toolInput;
    return null;
  }
  if (state.summaryAuthority && m.subagentId && !m.liveTail) {
    openBlock(state, m, m.subagentId);
    return null;
  }
  const block = m.subagentId ? openBlock(state, m, m.subagentId) : null;
  // A worker's interim reply is not the main agent acting, any more than a system-authored turn is.
  if (!block && !(m.type === 'user' && m.systemOrigin) && m.type !== 'worker-progress') closeBlocksTheMainAgentOutran(state.blocks);
  return { sink: block ? block.sink : state.top, block };
}

function toolDebug(debug: TranscriptMessage['debug']): DebugToolDetail | undefined {
  if (!debug || !(debug.toolRef || debug.toolInput !== undefined || debug.toolResult !== undefined)) return undefined;
  return {
    ...(debug.toolRef ? { toolRef: debug.toolRef } : {}),
    ...(debug.toolInput !== undefined ? { toolInput: debug.toolInput } : {}),
    ...(debug.toolResult !== undefined ? { toolResult: debug.toolResult } : {}),
    ...(debug.overCharacterThreshold === true ? { overCharacterThreshold: true as const } : {}),
  };
}

function toolEntry(m: TranscriptMessage): ToolCallEntry {
  const images = toolCallImages(m);
  const debug = toolDebug(m.debug);
  return {
    kind: toolCallLabel(m.toolName ?? '', m.toolDevice),
    input: m.toolInput ?? '',
    ...(images ? { images } : {}),
    ...(debug ? { debug } : {}),
  };
}

function userRow(m: FlatMessage, stripScheduledPrefix: boolean): ChatRow {
  const raw = m.text ?? '';
  const text = stripScheduledPrefix && raw.startsWith(SCHEDULED_PREFIX)
    ? raw.slice(SCHEDULED_PREFIX.length).trim()
    : raw;
  return {
    kind: 'user', text, attachments: m.attachments,
    ...(m.systemOrigin ? { systemOrigin: m.systemOrigin } : {}),
    ...(m.turnIndex !== undefined ? { turnIndex: m.turnIndex } : {}),
    ...(m.ts ? { ts: m.ts } : {}),
    ...(m.edited !== undefined ? { edited: m.edited } : {}),
    ...(m.debug?.agentMessage !== undefined ? { debug: { agentMessage: m.debug.agentMessage } } : {}),
  };
}

/** The row for a non-tool message. */
function messageRow(m: FlatMessage, stripScheduledPrefix: boolean): ChatRow {
  if (m.type === 'interaction') {
    return { kind: 'interaction', subtype: m.subtype ?? '', text: m.text ?? '', detail: m.interaction, ts: m.ts ?? null };
  }
  if (m.type === 'user') return userRow(m, stripScheduledPrefix);
  if (m.type === 'assistant' && m.noticeLevel) {
    return {
      kind: 'notice', level: m.noticeLevel, text: m.text ?? '',
      ...(m.noticeAction ? { noticeAction: m.noticeAction } : {}),
      ...(m.authAction ? { authAction: m.authAction } : {}),
    };
  }
  return {
    kind: 'assistant', text: m.text ?? '', streaming: false, attachments: m.attachments,
    ...(m.decisions?.length ? { decisions: m.decisions } : {}),
  };
}

/** Explicit lifecycle outranks parent idle and stale output. Old-server summaries retain the
 *  live-tail compatibility heuristic because false there is only structural inference. */
function applySummaries(blocks: Map<string, SubagentBlockState>, sessionLive: boolean): void {
  for (const block of blocks.values()) {
    if (!block.summary) continue;
    const open = block.summary.status !== undefined
      ? block.summary.status === 'running'
      : sessionLive && (block.summary.structurallyOpen || block.liveOpen === true);
    block.row.status = !block.ended && open ? 'running' : 'done';
    block.row.toolCount = block.summary.toolCount;
    block.row.hasDetails = block.summary.hasDetails;
    block.row.detailMode = 'lazy';
    if (block.summary.type) block.row.agentType = block.summary.type;
    if (block.summary.description) block.row.description = block.summary.description;
    if (block.summary.model) block.row.model = block.summary.model;
  }
}

/**
 * Team traffic at the top level of a lead's chat: a worker-tool call becomes its own row (or folds
 * into the card of the request it answers), and a worker's report, request or progress joins the
 * open update card. True when the message was placed; false leaves it to the ordinary rows — a
 * worker message whose header is not the server's keeps its plain hint form.
 */
function placeTeamMessage(state: BuildState, m: FlatMessage): boolean {
  const sink = state.top;
  if (m.type === 'tool') {
    const action = teamActionOf(m);
    if (!action) return false;
    const row = placeTeamAction(state.team, sink.rows, action, sink.toolBuf.length === 0);
    if (row) {
      flushTools(sink);
      sink.rows.push(row);
    }
    return true;
  }
  if (m.type === 'worker-progress') {
    flushTools(sink);
    addWorkerUpdate(state.team, sink.rows, progressUpdate(m));
    return true;
  }
  if (m.type === 'user' && m.systemOrigin) {
    const update = parseWorkerMessage(m.systemOrigin, m.text ?? '', m.ts ?? null);
    if (!update) return false;
    flushTools(sink);
    addWorkerUpdate(state.team, sink.rows, update);
    return true;
  }
  return false;
}

/** A board_open call at the top level: its own row, after the tool run before it. */
function placeBoardMessage(state: BuildState, m: FlatMessage): boolean {
  const action = boardActionOf(m);
  if (!action) return false;
  flushTools(state.top);
  state.top.rows.push({ kind: 'board-action', action });
  return true;
}

/** Rows after every persisted/live message: the in-flight block, the streaming flag, then the
 *  messages the model has not read yet. */
function appendTail(rows: ChatRow[], opts: BuildOpts, team: TeamBuild): void {
  // The in-flight block, after every persisted/live message and after any tool row of this turn.
  // Flagged `preview`: this is the only row whose text is still arriving, so it is the only one the
  // smooth reveal paces.
  if (opts.streamingText) {
    rows.push({ kind: 'assistant', text: opts.streamingText, streaming: true, preview: true });
  }
  if (opts.streaming) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.kind === 'assistant') {
        rows[i] = { ...r, streaming: true };
        break;
      }
    }
  }
  // Last of all: the messages the model has not read yet. Everything above them — including the
  // block being written right now — was produced without them, so they cannot sit any higher.
  for (const p of opts.pendingUser ?? []) {
    const update = p.systemOrigin ? parseWorkerMessage(p.systemOrigin, p.text, p.ts ?? null) : null;
    if (update) {
      addWorkerUpdate(team, rows, update, true);
      continue;
    }
    rows.push({
      kind: 'user', text: p.text, attachments: p.attachments, ts: p.ts, pending: true,
      ...(p.systemOrigin ? { systemOrigin: p.systemOrigin } : {}),
    });
  }
}

/**
 * Build the ordered prototype chat-row list from the fetched transcript plus any live-tail events not
 * yet reflected in it. Consecutive tool messages collapse into one `tools` row; a `divider` is emitted
 * whenever the local calendar day changes (incl. before the first message); the last assistant row
 * is flagged `streaming` when `opts.streaming` is set (the desktop stream renders no caret for it;
 * the mobile stream does).
 */
export function buildTranscriptRows(
  transcript: SessionTranscript,
  liveTail: LiveSessionMessage[],
  opts: BuildOpts = {},
): ChatRow[] {
  const now = opts.now ?? new Date();
  const formatDivider = opts.formatDivider ?? defaultDivider;
  const flat = flattenMessages(transcript, liveTail);
  const state = createBuildState(transcript, flat);
  let curDay: string | null = null;
  let firstUserSeen = false;
  for (const m of flat) {
    const day = dayStamp(m.ts);
    if (day !== curDay) {
      // Dividers live only in the top-level stream. Flushing nested sinks here would split one
      // subagent tool run into multiple rows even though no divider appears inside its card.
      flushTools(state.top);
      state.rows.push({ kind: 'divider', text: formatDivider(m.ts, now) });
      curDay = day;
    }
    const route = routeMessage(state, m);
    if (!route) continue;
    if (!route.block && (placeTeamMessage(state, m) || placeBoardMessage(state, m))) continue;
    if (m.type === 'tool') {
      if (route.block && !route.block.summary) route.block.row.toolCount += 1;
      route.sink.toolBuf.push(toolEntry(m));
      continue;
    }
    flushTools(route.sink);
    const isFirstUser = m.type === 'user' && !firstUserSeen;
    if (m.type === 'user') firstUserSeen = true;
    route.sink.rows.push(messageRow(m, isFirstUser && opts.stripScheduledPrefix === true));
  }
  flushAll(state);
  // Legacy compatibility only: a known running child can outlive its parent's turn.
  const sessionLive = opts.running ?? (opts.streaming === true || !!opts.streamingText);
  if (!sessionLive) closeOpenBlocks(state.blocks);
  if (state.summaryAuthority) applySummaries(state.blocks, sessionLive);
  appendTail(state.rows, opts, state.team);
  finishTeamRows(state.rows);
  return state.rows;
}
