// input:  running-executions snapshot + the incoming plain user message + injected side effects
// output: isInjectableMessage / backendSupportsInject / tryInjectIntoLiveTurn
// pos:    orch/ — the busy-channel branch of AgentRunner.route (inject into the live turn ⇄ queue)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/**
 * Mid-turn user-message injection.
 *
 * A user message arriving while its channel already has a live turn used to wait in
 * `conduit-queue` until that turn finished. When the backend can take it (Claude print mode,
 * `Capability.MidTurnInject`) it is instead written straight into the running turn's stdin, so the
 * agent sees it while it is still working rather than minutes later.
 *
 * Two things make this more than a write() call, both measured (K-010 §8/§9):
 *
 *  1. **Where it lands is a race.** On a tool-result boundary the message folds into the running
 *     turn — one result, no extra bookkeeping. Mid-text-generation the CLI drains its queue only
 *     AFTER that turn's result and then starts a turn of its own, whose reply has no caller
 *     awaiting it. The adapter routes that spontaneous turn to the continuation sink registered
 *     here, so the reply is streamed instead of dropped.
 *  2. **Writing is not delivering.** A message can sit queued inside the CLI for seconds. The
 *     `--replay-user-messages` echo fires at the moment of consumption (K-010 §12) and is the only
 *     honest delivery signal, so it — not the write — is what flips the message to delivered.
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
  appendUser: (sessionId: string, opts: { text: string; ts: string; attachments?: AttachmentMeta[] }) => void;
  appendAssistant: (sessionId: string, opts: { text: string; ts: string }) => void;
  appendTool: (sessionId: string, opts: { toolName: string; toolInput: string; ts: string }) => void;
  publishMessage: (ev: {
    sessionId: string; channel: string; role: 'user' | 'assistant' | 'tool'; text: string; ts: string;
    toolName?: string; toolInput?: string; attachments?: AttachmentMeta[];
  }) => void;
  /** Flip an already-surfaced message from pending to delivered (the replay-echo ack). */
  publishDelivered: (ev: { sessionId: string; channel: string; messageTs: string }) => void;
  publishStatus: (ev: { sessionId: string; channel: string; running: boolean }) => void;
  /** Open a ledger turn for the injected message. */
  beginLedgerTurn: (opts: { channel: string; sessionId: string; text: string; messageId: string }) => void;
  /** Daemon busy gate (`trackPendingTask`). */
  track: (delta: number) => void;
  now: () => string;
  summarizeToolInput?: (input: unknown) => string;
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

/** True when the backend declares `Capability.MidTurnInject` (Claude only). */
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

/** Per-channel bookkeeping for messages injected into the live turn but not yet replied to. */
interface ChannelInjectState {
  /** Injected, echo not yet seen — keyed by text so an echo can find its own message's ts. */
  pending: { text: string; ts: string; release: () => void }[];
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
  const release = (): void => {
    if (released) return;
    released = true;
    state.releases.delete(release);
    // Drop this message's pending entry too, so a message the CLI never echoed (cap expiry) does
    // not linger and swallow a LATER injection's ack by matching on the same text first.
    const idx = state.pending.findIndex((p) => p.release === release);
    if (idx !== -1) state.pending.splice(idx, 1);
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
  state.pending.push({ text, ts, release });

  // Surface it NOW. A queued message is invisible until its turn starts; an injected one is
  // already in front of the model, so the transcript must show it immediately. The history append
  // and the bus event share one ts so the web client's content de-dup resolves them to one row.
  deps.appendUser(sessionId, { text, ts, attachments: ctx.attachments });
  deps.publishMessage({ sessionId, channel: ctx.channel, role: 'user', text, ts, attachments: ctx.attachments });
  // Keep the ledger turn count aligned with the history's user-record count: rewind resolves a
  // turn index positionally against the ledger, so a user record with no matching ledger turn
  // would silently shift every later edit on this session.
  deps.beginLedgerTurn({ channel: ctx.channel, sessionId, text, messageId: ctx.messageId });

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
      deps.publishDelivered({ sessionId, channel, messageTs: entry.ts });
      // Folded into the running turn ⇒ that turn's own machinery carries the reply and holds the
      // gate. Otherwise the CLI is opening a turn of its own, so keep holding until it results.
      if (foldedIntoTurn) entry.release();
      else disposeIfIdle(channel);
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
    onToolUse: (name: string, input: unknown) => {
      const ts = deps.now();
      const toolInput = deps.summarizeToolInput ? deps.summarizeToolInput(input) : '';
      deps.appendTool(sessionId, { toolName: name, toolInput, ts });
      deps.publishMessage({ sessionId, channel, role: 'tool', text: '', toolName: name, toolInput, ts });
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
