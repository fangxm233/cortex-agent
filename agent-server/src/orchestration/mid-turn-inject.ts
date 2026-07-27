// input:  live execution, incoming message, lossless DEBUG/tool side-effect seams
// output: injected-turn two-phase commit plus id-correlated spontaneous tool event forwarding
// pos:    busy-channel branch of AgentRunner.route (inject into live turn ⇄ queue)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/**
 * Mid-turn user-message injection.
 *
 * A user message arriving while its channel already has a live turn used to wait in
 * `conduit-queue` until that turn finished. When the backend can take it (Claude print mode or PI
 * RPC, via `Capability.MidTurnInject`) it is written into the live backend process, so the
 * agent sees it while it is still working rather than minutes later.
 *
 * Two things make this more than a write() call, both measured:
 *
 *  1. **Where it lands is a race.** On a tool-result boundary the message folds into the running
 *     turn — one result, no extra bookkeeping. Mid-text-generation the CLI drains its queue only
 *     AFTER that turn's result and then starts a turn of its own, whose reply has no caller
 *     awaiting it. The adapter routes that spontaneous turn to the continuation sink registered
 *     here, so the reply is streamed instead of dropped.
 *  2. **Writing is not delivering.** A message can sit queued inside the CLI for seconds (measured:
 *     written at 6.0s, read at 12.0s). Each adapter reports the backend's consumption edge; for
 *     Claude that is `--replay-user-messages`, while PI reports a user `message_start`.
 *
 * Because of (2) the message enters the record in TWO phases:
 *
 *  - **write** — publish the `session.message` with `pending: true` so every connected client can
 *    show it right away, but append nothing. Until the model has read it, everything the agent is
 *    emitting was produced without it, and belongs ABOVE it.
 *  - **consumption** — the adapter ack appends the history record and opens the ledger turn, stamped
 *    with the consumption time, then publishes `session.message.delivered` carrying the pending
 *    row's key and the new committed key so the client can re-key its row to the one a transcript
 *    refetch will return.
 *
 * If the message is never consumed (wedged CLI, process death, the injection window closing) it is
 * committed at that seal instead: a message the user really sent is never silently lost, and it
 * enters the record at the point it stopped being pending rather than at a write time it never had.
 *
 * All side effects are injected so the branch is unit-testable without a backend; production wiring
 * lives in `agent-runner.ts`.
 */

import { Capability, CAPABILITIES_BY_BACKEND } from '../agent-adapter/capabilities.js';
import type { Backend, ContinuationSink, InjectionAckSink, UserMessage } from '../agent-adapter/types.js';
import { SYNTHETIC_CALLBACK_SENDER } from '@platform/types.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';
import { createLogger } from '@core/log.js';

const log = createLogger('mid-turn-inject');

/** Upper bound on how long an injected message may hold the busy gate while waiting for its reply.
 *  Purely a leak guard: without it a message the CLI never consumes (process wedged, reply lost)
 *  would pin the daemon's restart gate forever. */
const DEFAULT_MAX_WAIT_MS = Number(process.env.CORTEX_INJECT_WAIT_MAX_S ?? 600) * 1000;

/** The subset of a pooled AgentProcess this path needs. */
export interface InjectableProcess {
  injectUserMessage?(message: UserMessage): boolean;
  setInjectionAckSink?(sink: InjectionAckSink): void;
  setContinuationSink?(sink: ContinuationSink): void;
}

/** The subset of a RunningExecution this path needs. */
export interface LiveExecutionLike {
  backend: string;
  agentProcess?: unknown;
}

export interface MidTurnInjectDeps {
  /** Live executions registered on the channel (`runningExecutions.getByChannel`). */
  getLiveExecutions: (channel: string) => LiveExecutionLike[];
  /** The channel's live assistant-output callback. Captured at inject time, while the running turn
   *  still owns it — the spontaneous turn arrives after that turn cleared it. */
  getStreamingCallback: (channel: string) => ((text: string) => void) | null;
  appendUser: (sessionId: string, opts: { text: string; ts: string; attachments?: AttachmentMeta[]; agentMessage?: string }) => void;
  appendAssistant: (sessionId: string, opts: { text: string; ts: string }) => void;
  appendTool: (sessionId: string, opts: { toolName: string; toolInput: string; ts: string; toolUseId?: string; fullInput?: unknown }) => void;
  appendToolResult?: (sessionId: string, opts: { toolUseId: string; content: string; isError: boolean }) => void;
  publishMessage: (ev: {
    sessionId: string; channel: string; role: 'user' | 'assistant' | 'tool'; text: string; ts: string;
    toolName?: string; toolInput?: string; attachments?: AttachmentMeta[]; pending?: boolean;
  }) => void;
  /** Commit an already-surfaced pending message into the stream: `messageTs` is the pending row's
   *  key, `committedTs` the history/order key it is re-keyed to. */
  publishDelivered: (ev: { sessionId: string; channel: string; messageTs: string; committedTs: string }) => void;
  publishStatus: (ev: { sessionId: string; channel: string; running: boolean }) => void;
  /** Open a ledger turn for the injected message. */
  beginLedgerTurn: (opts: { channel: string; sessionId: string; text: string; messageId: string }) => void;
  /** Daemon busy gate (`trackPendingTask`). */
  track: (delta: number) => void;
  now: () => string;
  summarizeToolInput?: (input: unknown) => string;
  /** Frozen at injection time so one message is captured consistently. */
  captureDebug?: boolean;
  maxWaitMs?: number;
}

export interface MidTurnInjectCtx {
  channel: string;
  /** Stable Cortex track session id. Null (never-used channel) ⇒ nothing to surface against. */
  sessionId: string | null;
  text: string;
  senderId: string;
  /** The inbound platform message id — the ledger turn's key. */
  messageId: string;
  attachments?: AttachmentMeta[];
}

/**
 * Only a PLAIN user message may be folded into a turn already in flight.
 *
 * `!commands` carry their own execution semantics (cancel / thread / profile …) and must be
 * dispatched, not handed to a model mid-thought. Synthetic wake / callback messages (manager-qa
 * escalation, task-origin wake, scheduled re-entry) are the system re-entering a session and must
 * open their own turn — folding one into an unrelated running turn would break that contract.
 * Message edits take the supersede path instead, which kills the execution before re-routing, so
 * by the time an edit reaches here no live turn remains to inject into.
 */
export function isInjectableMessage(opts: { text: string; senderId: string }): boolean {
  const text = (opts.text ?? '').trim();
  if (!text) return false;
  if (text.startsWith('!')) return false;
  if (opts.senderId === SYNTHETIC_CALLBACK_SENDER) return false;
  return true;
}

/** True when the backend declares `Capability.MidTurnInject`. */
export function backendSupportsInject(backend: string): boolean {
  return !!CAPABILITIES_BY_BACKEND[backend as Backend]?.has(Capability.MidTurnInject);
}

/** First live execution on the channel that can actually take an injection. A Claude session in
 *  TUI mode declares the capability at backend level but exposes no `injectUserMessage`. */
function selectInjectTarget(execs: LiveExecutionLike[]): InjectableProcess | null {
  for (const exec of execs) {
    if (!backendSupportsInject(exec.backend)) continue;
    const proc = exec.agentProcess as InjectableProcess | undefined;
    if (proc && typeof proc.injectUserMessage === 'function') return proc;
  }
  return null;
}

/** An injected message written to the backend but not yet read by the model. */
interface PendingInjection {
  /** Matched against the backend lifecycle ack, which carries the original text. */
  text: string;
  /** Write-time ts — the key the pending row is showing under on every connected client. */
  ts: string;
  /** Move it into the conversation record (history + ledger turn + the delivered event). Single-fire. */
  commit: () => void;
  release: () => void;
}

/** Per-channel bookkeeping for messages injected into the live turn but not yet replied to. */
interface ChannelInjectState {
  /** Injected, echo not yet seen — keyed by text so an echo can find its own message's ts. */
  pending: PendingInjection[];
  /** Every busy-gate release still outstanding on this channel (each single-fire). */
  releases: Set<() => void>;
  /** True once the spontaneous turn has been marked running, so we publish that edge only once. */
  continuationRunning: boolean;
}

const channelStates = new Map<string, ChannelInjectState>();

function stateFor(channel: string): ChannelInjectState {
  let s = channelStates.get(channel);
  if (!s) {
    s = { pending: [], releases: new Set(), continuationRunning: false };
    channelStates.set(channel, s);
  }
  return s;
}

function disposeIfIdle(channel: string): void {
  const s = channelStates.get(channel);
  if (s && s.pending.length === 0 && s.releases.size === 0) channelStates.delete(channel);
}

/**
 * Try to deliver `ctx` into the turn already running on its channel.
 *
 * Returns true when the message was accepted by the backend — the caller must then NOT enqueue it.
 * Every rejection path (no live turn, incapable backend, non-plain message, backend refusal)
 * returns false and leaves no trace, so the caller falls through to today's queue behaviour.
 */
export function tryInjectIntoLiveTurn(deps: MidTurnInjectDeps, ctx: MidTurnInjectCtx): boolean {
  if (!isInjectableMessage(ctx)) return false;
  // Without a session id there is nowhere to record or publish the message, so it would be
  // invisible until the turn ended — strictly worse than queueing it.
  const sessionId = ctx.sessionId;
  if (!sessionId) return false;

  const proc = selectInjectTarget(deps.getLiveExecutions(ctx.channel));
  if (!proc) return false;

  const text = ctx.text;
  if (!proc.injectUserMessage!({ text, attachments: attachmentsForBackend(ctx.attachments) })) {
    // The turn ended between the busy check and the write. No surfacing has happened yet, so the
    // caller can still queue this message as an ordinary turn.
    return false;
  }

  const state = stateFor(ctx.channel);
  const ts = deps.now();

  // Busy-gate bracket: the reply to this message may arrive on a turn nobody is awaiting, after
  // the originating turn released its own hold. Without this a deferred daemon restart could fire
  // in that window and kill the backend mid-reply.
  deps.track(+1);
  let released = false;
  let committed = false;
  // Phase 2 of the commit. Everything that puts the message into the durable record happens here,
  // at the instant it stops being pending — never at write time, when the model has not read it and
  // whatever the agent is emitting was produced without it. The ledger turn moves WITH the history
  // record: rewind resolves turn indices positionally over the history's user records, so a record
  // without its turn (or a turn without its record) shifts every later edit index on the session.
  const commit = (): void => {
    if (committed) return;
    committed = true;
    const committedTs = deps.now();
    deps.appendUser(sessionId, {
      text,
      ts: committedTs,
      attachments: ctx.attachments,
      ...(deps.captureDebug ? { agentMessage: text } : {}),
    });
    deps.beginLedgerTurn({ channel: ctx.channel, sessionId, text, messageId: ctx.messageId });
    // Published last: a client refetching the transcript on this event must find the record.
    deps.publishDelivered({ sessionId, channel: ctx.channel, messageTs: ts, committedTs });
  };
  const release = (): void => {
    if (released) return;
    released = true;
    state.releases.delete(release);
    // Drop this message's pending entry too, so a message the CLI never echoed (cap expiry) does
    // not linger and swallow a LATER injection's ack by matching on the same text first.
    const idx = state.pending.findIndex((p) => p.release === release);
    if (idx !== -1) state.pending.splice(idx, 1);
    // The window closed. If no delivery ack came (wedged CLI, process death, cap expiry) this is
    // where the message stopped being pending, so this is where it honestly enters the record —
    // a message the user really sent is never silently dropped. A no-op once already committed.
    commit();
    deps.track(-1);
    disposeIfIdle(ctx.channel);
  };
  state.releases.add(release);
  const capMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (capMs > 0) {
    const timer = setTimeout(() => {
      if (!released) log.warn(`Injected message on ${ctx.channel} got no reply within the cap — releasing the busy gate`);
      release();
    }, capMs);
    timer.unref?.();
  }
  state.pending.push({ text, ts, commit, release });

  // Phase 1: surface it NOW, marked pending. A queued message is invisible until its turn starts,
  // so the message must appear immediately — but as a row the reader can tell the model has not
  // read yet, pinned below whatever the agent is currently saying rather than inserted above it.
  deps.publishMessage({ sessionId, channel: ctx.channel, role: 'user', text, ts, attachments: ctx.attachments, pending: true });

  registerSinks(deps, ctx.channel, sessionId, proc, state);
  return true;
}

/** (Re)register the ack + continuation sinks. Both are session-scoped and last-registration-wins,
 *  so they read the shared per-channel state rather than closing over one message. */
function registerSinks(
  deps: MidTurnInjectDeps,
  channel: string,
  sessionId: string,
  proc: InjectableProcess,
  state: ChannelInjectState,
): void {
  // Captured while the running turn still owns it — by the time a spontaneous turn speaks, the
  // originating turn has cleared the channel's streaming callback.
  const streamAssistant = deps.getStreamingCallback(channel);

  proc.setInjectionAckSink?.({
    onDelivered: ({ text, foldedIntoTurn }) => {
      const idx = state.pending.findIndex((p) => p.text === text);
      if (idx === -1) return;
      const [entry] = state.pending.splice(idx, 1);
      // The backend consumption edge is the commit instant: everything emitted while the message
      // was queued stays above it in the record.
      entry.commit();
      // Folded into the running turn ⇒ that turn's own machinery carries the reply and holds the
      // gate. Otherwise the CLI is opening a turn of its own, so keep holding until it results.
      if (foldedIntoTurn) entry.release();
      else disposeIfIdle(channel);
    },
    onUndelivered: ({ text }) => {
      const entry = state.pending.find((p) => p.text === text);
      // `release` removes this entry, commits it at the seal, and is single-fire.
      entry?.release();
    },
  });

  proc.setContinuationSink?.({
    onAssistantText: (text: string) => {
      if (!text) return;
      if (!state.continuationRunning) {
        state.continuationRunning = true;
        // The originating turn already sealed the session idle; a spontaneous turn is real work.
        deps.publishStatus({ sessionId, channel, running: true });
      }
      try { streamAssistant?.(text); } catch (e) { log.warn('injection stream callback threw:', (e as Error).message); }
      const ts = deps.now();
      deps.appendAssistant(sessionId, { text, ts });
      deps.publishMessage({ sessionId, channel, role: 'assistant', text, ts });
    },
    onToolUse: (name: string, input: unknown, toolUseId: string) => {
      const ts = deps.now();
      const toolInput = deps.summarizeToolInput ? deps.summarizeToolInput(input) : '';
      deps.appendTool(sessionId, {
        toolName: name,
        toolInput,
        ts,
        ...(deps.captureDebug ? { toolUseId, fullInput: input } : {}),
      });
      deps.publishMessage({ sessionId, channel, role: 'tool', text: '', toolName: name, toolInput, ts });
    },
    onToolResult: (toolUseId: string, content: string, isError: boolean) => {
      if (deps.captureDebug) deps.appendToolResult?.(sessionId, { toolUseId, content, isError });
    },
    onResult: () => {
      state.continuationRunning = false;
      deps.publishStatus({ sessionId, channel, running: false });
      // The spontaneous turn is done: release every outstanding hold on this channel (a process
      // death delivers an interrupted result through the same path, so nothing can hang).
      for (const release of [...state.releases]) release();
      state.pending = [];
      disposeIfIdle(channel);
    },
  });
}

/** Map web attachment metadata onto the backend's UserMessage attachment shape. */
function attachmentsForBackend(attachments?: AttachmentMeta[]): UserMessage['attachments'] {
  if (!attachments?.length) return undefined;
  return attachments.map((a) => ({ mimeType: a.mimeType, path: a.path }));
}

/** Test hook: drop all per-channel injection state. */
export const _test = {
  reset(): void { channelStates.clear(); },
};
