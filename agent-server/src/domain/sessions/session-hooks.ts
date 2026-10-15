import { randomUUID } from 'node:crypto';
import { emitCortexEvent, type HookEmitResult } from '@core/hook-bus.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';
import type { PlatformAdapter, OutputStream } from '@platform/index.js';
import type { EngineSelection } from '@domain/agents/engine-selection.js';
import { resolveRunSelection } from '@domain/runs/config-resolver.js';
import { startRun } from '@domain/runs/service.js';
import type { RunObserver, RunRequest } from '@domain/runs/request.js';
import { continuationRunRequest } from '@domain/runs/builders.js';
import type { RunEvent } from '@domain/runs/events.js';
import { engines } from '@domain/runs/engines.js';
import { getSessionAsync } from '@domain/sessions/session.js';
import { effectiveBackendSessionId, sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { filterHookEntries, loadHookRegistry } from '@store/hook-registry.js';
import { t } from '@core/i18n.js';

const log = createLogger('session-hook');
const DEFAULT_TIMEOUT_MS = 60_000;
const SESSION_EVENTS = {
  onNew: 'cortex:session.new',
  onMessageEnd: 'cortex:session.messageEnd',
} as const;

// ── Config ────────────────────────────────────────────────────────────────────

export type HookName = keyof typeof SESSION_EVENTS;

function hasSessionHook(name: HookName): boolean {
  return filterHookEntries(loadHookRegistry(), { event: SESSION_EVENTS[name] }).length > 0;
}

export function isOnNewHookConfigured(): boolean {
  return hasSessionHook('onNew');
}

export function isOnMessageEndHookConfigured(): boolean {
  return hasSessionHook('onMessageEnd');
}

// ── Unified hook pipeline ─────────────────────────────────────────────────────

/** Per-hook context fed to the subprocess (via stdin JSON) and the formatters. */
export interface SessionHookContext {
  channel: string;
  /** The Cortex session id — the registry key, the id every Cortex surface and API names. */
  sessionId: string;
  /** The backend's own id for the session's conversation (its transcript), when it has one. */
  backendSessionId?: string | null;
  executionId?: string | null;
  selection?: EngineSelection | null;
}

/** Caller-supplied formatters — keep wording per-hook so existing UX text doesn't change.
 *  All formatters return short single-line strings; runSessionHook appends them via OutputStream,
 *  so they share the same Slack thread/group as surrounding agent output. */
export interface SessionHookFormat {
  /** Status line shown immediately when the hook starts. */
  statusLine: () => string;
  /** Preview line shown when the hook produced non-empty stdout. */
  previewLine: (output: string) => string;
  /** Error line shown when spawn failed / non-zero exit / timeout. */
  errorLine: (err: string) => string;
  /** Optional line when stdout was empty after a successful run. Return null to stay silent. */
  emptyLine?: () => string | null;
}

/** When set, the hook stdout is injected as a fresh agent turn on the session's conversation.
 *  All assistant output is appended into the same OutputStream so it visually
 *  continues the hook's status/preview lines. */
export interface SessionHookInject {
  /** The Cortex session the injected turn belongs to. */
  sessionId: string;
  /** The backend conversation it resumes. Differs from `sessionId` once the backend has assigned
   *  its own id (Slack, Feishu, the Web after a first turn) or a rewind has moved it. */
  backendSessionId: string;
  selection: EngineSelection | null;
  /** Session-pool key for the injected turn.
   *  - onNew: an ISOLATED key (onNewInjectSessionKey(channel)) so resuming the old session for
   *    the pre-close turn never collides with the channel's live pool slot — see the race below.
   *  - onMessageEnd: the channel itself, because the injection continues the live conversation. */
  sessionKey: string;
  /** Forwarded to runAgent as `trigger`, useful for telemetry / cost grouping. */
  trigger?: string;
  /** onMessageEnd: the request of the turn this injection follows. The injected turn reuses it, so
   *  it asks the pool for the very engine that turn ran on instead of respawning the process. */
  follows?: RunRequest | null;
}

/** Pool key for the onNew hook's injected "pre-close" turn.
 *
 *  MUST be distinct from the channel's live session-pool slot (which is keyed by the channel
 *  itself — an interactive run opens its engine under `engineKey === channel`). Race it guards
 *  against:
 *  `!new` fires this hook fire-and-forget, then synchronously closes the pooled session +
 *  resetChannelSession(channel). The hook's memory-write subprocess finishes LATER and injects
 *  its stdout as a final turn that RESUMES the old session. If that turn used `channel` as its
 *  pool key it would re-create (resurrect) a live session under the channel slot AFTER the reset
 *  — so the next message of the brand-new conversation (also keyed by channel) would reuse the
 *  resurrected OLD session instead of starting fresh. Routing the pre-close turn to a dedicated
 *  key keeps it off the live slot; we close that key once the turn is done. */
export function onNewInjectSessionKey(channel: string): string {
  return `${channel}::onnew-hook`;
}

/** Injected-turn dependencies — seam for unit tests (default binds the real run service + a
 *  backend-aware session close). */
export interface InjectDeps {
  startRun: typeof startRun;
  /** Close the pooled session created for the injected turn (by sessionKey). */
  closeInjectedSession: (channel: string, sessionKey: string) => void | Promise<void>;
}

const defaultInjectDeps: InjectDeps = {
  startRun,
  closeInjectedSession: async (channel: string, sessionKey: string) => {
    try {
      await engines.close(sessionKey);
    } catch (e: any) {
      log.warn(`closeInjectedSession failed (${sessionKey}): ${e?.message || e}`);
    }
  },
};

/** The next turn on the engine `after` ran on: same session, agent, selection, policy and route —
 *  the route keeps `after`'s trigger, since the gateway URL names it and the process was spawned on
 *  it; the follow-up's own trigger is what its execution and cost are recorded under. */
function followUpRequest(
  after: RunRequest,
  next: { prompt: string; trigger: string; backendSessionId: string },
): RunRequest {
  return {
    ...after,
    runId: randomUUID(),
    session: { ...after.session, backendSessionId: next.backendSessionId },
    prompt: { text: next.prompt, attachments: [] },
    context: {
      ...after.context,
      trigger: next.trigger,
      routeTrigger: after.context.routeTrigger ?? after.context.trigger,
    },
  };
}

/** Inject hook stdout as a fresh agent turn on `inject.backendSessionId`, routed through
 *  `stream`. Runs on `inject.sessionKey`; for onNew that is an isolated key which we close
 *  afterwards (the resurrected old session must not linger on / collide with the channel slot).
 *  For onMessageEnd the key IS the channel (live conversation) and is left open. */
export async function runHookInjection(
  output: string,
  spec: SessionHookSpec,
  stream: OutputStream,
  deps: InjectDeps = defaultInjectDeps,
): Promise<void> {
  const inject = spec.inject;
  if (!inject) return;
  try {
    const request: RunRequest = inject.follows ? followUpRequest(inject.follows, {
      prompt: output, trigger: inject.trigger ?? `hook:${spec.name}`, backendSessionId: inject.backendSessionId,
    }) : continuationRunRequest({
      session: {
        // The injected turn resumes the OLD backend conversation, as a turn of its Cortex session.
        sessionId: inject.sessionId,
        backendSessionId: inject.backendSessionId,
        // The pool key is the sessionKey the hook has always used (onNew: the isolated
        // `${channel}::onnew-hook`; onMessageEnd: the channel). Changing it would silently re-pool
        // every live hook session, so it stays keyed on the injected session key and not on the
        // session id.
        engineKey: inject.sessionKey,
      },
      selection: resolveRunSelection({ selection: inject.selection, channel: spec.ctx.channel }),
      prompt: output,
      channel: spec.ctx.channel,
      project: 'general',
      trigger: inject.trigger ?? `hook:${spec.name}`,
    });
    const observer: RunObserver = {
      onEvent(event: RunEvent): void {
        if (event.type === 'assistant_text') stream.emitText(event.text);
      },
    };
    const run = deps.startRun(request, [observer]);
    await run.result;
  } catch (err: any) {
    const msg = err?.message || String(err);
    log.error(`hook ${spec.name} injected agent failed: ${msg}`);
    stream.emitText(`${Icons.warning} ${spec.name} hook follow-up failed: ${msg}`);
  } finally {
    // Only the isolated (onNew) key is torn down; the channel live slot (onMessageEnd) stays.
    if (inject.sessionKey !== spec.ctx.channel) {
      await deps.closeInjectedSession(spec.ctx.channel, inject.sessionKey);
    }
  }
}

export interface SessionHookSpec {
  name: HookName;
  ctx: SessionHookContext;
  format: SessionHookFormat;
  inject?: SessionHookInject | null;
}

function buildHookEnv(name: HookName, ctx: SessionHookContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CORTEX_HOOK_CHANNEL: ctx.channel,
    CORTEX_HOOK_SESSION_ID: ctx.sessionId,
    CORTEX_HOOK_TRIGGER: name === 'onNew' ? 'new' : 'messageEnd',
  };
  if (ctx.backendSessionId) env.CORTEX_HOOK_BACKEND_SESSION_ID = ctx.backendSessionId;
  if (ctx.executionId) env.CORTEX_HOOK_EXECUTION_ID = ctx.executionId;
  return env;
}

function buildHookPayload(
  name: HookName,
  ctx: SessionHookContext,
): Record<string, unknown> {
  return {
    channel: ctx.channel,
    sessionId: ctx.sessionId,
    backendSessionId: ctx.backendSessionId ?? null,
    executionId: ctx.executionId ?? null,
    backend: ctx.selection?.backend ?? null,
    model: ctx.selection?.model ?? null,
    trigger: name === 'onNew' ? 'new' : 'messageEnd',
    timestampIso: new Date().toISOString(),
  };
}

async function flushHookStream(stream: OutputStream, label: string, phase: string): Promise<void> {
  await stream.flush().catch((error: any) => {
    log.warn(`stream.flush ${phase} failed (${label}): ${error?.message || error}`);
  });
}

interface SessionHookResult {
  stdout: string;
  error?: string;
}

function asSessionHookResult(result: HookEmitResult): SessionHookResult | null {
  if (result.error) return { stdout: '', error: result.error };
  if (typeof result.result === 'string') return { stdout: result.result };
  return null;
}

async function handleHookResult(
  result: SessionHookResult,
  spec: SessionHookSpec,
  stream: OutputStream,
  deps: InjectDeps,
  label: string,
): Promise<void> {
  if (result.error) {
    stream.emitText(spec.format.errorLine(result.error));
    await flushHookStream(stream, label, 'after error');
    return;
  }
  if (!result.stdout) {
    const empty = spec.format.emptyLine?.();
    if (empty) stream.emitText(empty);
    await flushHookStream(stream, label, 'on empty');
    return;
  }
  stream.emitText(spec.format.previewLine(result.stdout));
  if (!spec.inject) {
    await flushHookStream(stream, label, 'no-inject');
    return;
  }
  try {
    await runHookInjection(result.stdout, spec, stream, deps);
  } finally {
    await flushHookStream(stream, label, 'after inject');
  }
}

/** Run configured session subscribers and preserve the display/injection pipeline. */
export async function runSessionHook(
  spec: SessionHookSpec,
  stream: OutputStream,
  deps: InjectDeps = defaultInjectDeps,
): Promise<void> {
  if (!hasSessionHook(spec.name)) return;
  stream.emitText(spec.format.statusLine());
  const results = await emitCortexEvent(
    SESSION_EVENTS[spec.name],
    buildHookPayload(spec.name, spec.ctx),
    {
      env: buildHookEnv(spec.name, spec.ctx),
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    },
  );
  let handled = false;
  for (const emitted of results) {
    if (emitted.stderr) log.warn(`stderr (${emitted.id}): ${emitted.stderr.trim()}`);
    const result = asSessionHookResult(emitted);
    if (!result) continue;
    handled = true;
    await handleHookResult(result, spec, stream, deps, emitted.id);
  }
  if (!handled) await flushHookStream(stream, spec.name, 'no-result');
}

// ── onNew (pre-close) entry points ────────────────────────────────────────────

const ONNEW_FORMAT: SessionHookFormat = {
  statusLine: () => `${Icons.hook} ${t('notice.hook.newRunning')}`,
  previewLine: (out) => {
    const preview = out.length > 80 ? out.slice(0, 80) + '…' : out;
    return `${Icons.hook} ${preview}`;
  },
  errorLine: (err) => `${Icons.warning} ${t('notice.hook.newFailed', { error: err })}`,
  emptyLine: () => `${Icons.hook} ${t('notice.hook.empty')}`,
};

const ONMESSAGEEND_FORMAT: SessionHookFormat = {
  statusLine: () => `${Icons.hook} ${t('notice.hook.lockChecking')}`,
  previewLine: (out) => {
    const preview = out.length > 80 ? out.slice(0, 80) + '…' : out;
    return `${Icons.hook} ${preview}`;
  },
  errorLine: (err) => `${Icons.warning} ${t('notice.hook.lockFailed', { error: err })}`,
  // onMessageEnd is silent on empty output — the common case is "nothing to remind".
  emptyLine: () => null,
};

/** Resolve the Slack thread anchor for a fresh onNew vm:
 *    1. Caller-supplied threadAnchorId (e.g. user typed !new in-thread).
 *    2. Last turn's statusMessageTs from the conversation ledger.
 *    3. null → vm starts a top-level message and self-anchors. */
export async function resolveOnNewThreadAnchor(channel: string, threadAnchorId?: string | null): Promise<string | null> {
  if (threadAnchorId) return threadAnchorId;
  const conv = await conversationLedger.getConversation(channel);
  if (conv?.turns.length) {
    for (let i = conv.turns.length - 1; i >= 0; i--) {
      const ts = conv.turns[i].statusMessageTs;
      if (ts) return ts;
    }
  }
  return null;
}

interface SessionHookTarget {
  selection: EngineSelection | null;
  /** The backend conversation an injected turn resumes; null when the session has none yet. */
  backendSessionId: string | null;
}

/** Read the engine choice from the session record, never another session's channel state. */
async function sessionHookTarget(sessionId: string): Promise<SessionHookTarget> {
  const record = await sessionStore.getById(sessionId);
  return {
    selection: record?.selection ?? null,
    backendSessionId: record ? effectiveBackendSessionId(record) : null,
  };
}

function onNewHookSpec(channel: string, sessionId: string, target: SessionHookTarget): SessionHookSpec {
  const { selection, backendSessionId } = target;
  return {
    name: 'onNew',
    ctx: { channel, sessionId, selection, backendSessionId },
    format: ONNEW_FORMAT,
    // A session with no backend conversation yet has nothing for a pre-close turn to continue.
    inject: backendSessionId ? {
      sessionId,
      backendSessionId,
      selection,
      sessionKey: onNewInjectSessionKey(channel),
      trigger: 'hook:onNew',
    } : null,
  };
}

/** Build the onNew SessionHookSpec + a fresh stream. Returns null when the hook isn't
 *  configured or there's no live session to capture context from. */
async function prepareOnNewRun(
  channel: string,
  adapter: PlatformAdapter,
  threadAnchorId?: string | null,
): Promise<{ spec: SessionHookSpec; stream: OutputStream } | null> {
  if (!isOnNewHookConfigured()) return null;

  const sessionId = await getSessionAsync(channel);
  if (!sessionId) {
    log.info('onNew hook skipped: no active session for channel', channel);
    return null;
  }
  const target = await sessionHookTarget(sessionId);
  const anchor = await resolveOnNewThreadAnchor(channel, threadAnchorId);
  const stream = adapter.openOutputStream({ type: 'interactive-reply', conduit: channel, sessionId: '' }, { threadId: anchor });
  return { spec: onNewHookSpec(channel, sessionId, target), stream };
}

/** Fire-and-forget onNew hook used by the !new command and the "New" status button.
 *  Returns immediately; the hook subprocess and any injected agent turn run async
 *  via the unified pipeline. The session is closed by the caller in parallel —
 *  sessionId is captured up-front so the JSONL still resolves after deletion. */
export async function fireAndForgetPreCloseHook(
  channel: string,
  adapter: PlatformAdapter,
  threadAnchorId?: string | null,
): Promise<void> {
  const prepared = await prepareOnNewRun(channel, adapter, threadAnchorId);
  if (!prepared) return;
  void runSessionHook(prepared.spec, prepared.stream).catch((err) => {
    log.error('onNew hook async completion failed:', err?.message || err);
  });
}

// ── onMessageEnd entry point ─────────────────────────────────────────────────

export interface OnMessageEndArgs {
  channel: string;
  /** The Cortex session id. */
  sessionId: string;
  /** The backend conversation the turn ran on; a follow-up turn resumes it. */
  backendSessionId: string | null;
  executionId: string;
  selection?: EngineSelection | null;
  /** The finished turn's request; see {@link SessionHookInject.follows}. */
  request?: RunRequest | null;
  /** OutputStream to extend — pass the assistant turn's stream so the hook lines
   *  thread under the just-finished reply rather than leaking to top-level. */
  stream: OutputStream;
}

/** Run the onMessageEnd hook against the just-finished assistant turn's vm.
 *  No-op when not configured. */
export async function runMessageEndSessionHook(args: OnMessageEndArgs): Promise<void> {
  if (!isOnMessageEndHookConfigured()) return;
  const spec: SessionHookSpec = {
    name: 'onMessageEnd',
    ctx: {
      channel: args.channel,
      sessionId: args.sessionId,
      backendSessionId: args.backendSessionId,
      executionId: args.executionId,
      selection: args.selection ?? null,
    },
    format: ONMESSAGEEND_FORMAT,
    inject: args.backendSessionId ? {
      sessionId: args.sessionId,
      backendSessionId: args.backendSessionId,
      selection: args.selection ?? null,
      // onMessageEnd continues the live conversation — keep it on the channel pool slot.
      sessionKey: args.channel,
      trigger: 'hook:onMessageEnd',
      follows: args.request ?? null,
    } : null,
  };
  await runSessionHook(spec, args.stream);
}

/** Run the onMessageEnd hook for a turn that just finished. The hook's lines extend the assistant
 *  turn's OutputStream, so hook output (status / preview / error) and any injected agent turn share
 *  one continuous thread with the reply we just finished — no top-level leak, no detached stream.
 *  The selection comes from the turn's conversation record, never from a global. */
export async function runMessageEndForTurn(args: {
  channel: string;
  /** The Cortex session id (the registry key), not the backend's. */
  sessionId: string | null;
  /** The backend id the turn reported; the registry's resume target when it reported none. */
  backendSessionId: string | null;
  executionId: string | null; stream: OutputStream | null | undefined;
  request?: RunRequest | null;
}): Promise<void> {
  if (!isOnMessageEndHookConfigured() || !args.sessionId) return;
  if (!args.stream) {
    log.warn('onMessageEnd hook skipped: assistant stream unavailable on onAssistantMessage');
    return;
  }
  try {
    // Selection comes from the session registry (the single source of truth), keyed by the turn's
    // sessionId — never from the channel-level ledger, which could name a different session.
    const target = await sessionHookTarget(args.sessionId);
    await runMessageEndSessionHook({
      channel: args.channel,
      sessionId: args.sessionId,
      backendSessionId: args.backendSessionId ?? target.backendSessionId,
      executionId: args.executionId ?? '',
      selection: target.selection,
      stream: args.stream,
      request: args.request,
    });
  } catch (err) {
    log.error('onMessageEnd hook failed:', (err as Error)?.message || err);
  }
}
