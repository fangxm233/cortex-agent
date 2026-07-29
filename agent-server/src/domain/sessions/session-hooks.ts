// input:  hook registry/events, agent sessions, OutputStream
// output: session hook execution and optional agent injection helpers
// pos:    Dispatches session events and injects prompt results
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import * as path from 'node:path';
import { emitCortexEvent, type HookEmitResult } from '@core/hook-bus.js';
import { createLogger } from '@core/log.js';
import { HOOKS_DIR } from '@core/paths.js';
import { Icons } from '../../core/icons.js';
import type { PlatformAdapter, OutputStream } from '@platform/index.js';
import { runAgent, resolveBackendForChannel } from '@domain/agents/index.js';
import { getAdapter } from '../../agent-adapter/index.js';
import type { Backend } from '../../agent-adapter/index.js';
import type { AgentHandle } from '@core/types/agent-types.js';
import { getSessionAsync } from '@domain/sessions/session.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { filterHookEntries, loadHookRegistry, type HookEntry } from '@store/hook-registry.js';

const log = createLogger('session-hook');
const DEFAULT_TIMEOUT_MS = 60_000;
const SESSION_EVENTS = {
  onNew: 'cortex:session.new',
  onMessageEnd: 'cortex:session.messageEnd',
} as const;

// ── Config types ──────────────────────────────────────────────────────────────

export interface SessionHookConfig {
  command: string;
  args?: string[];
  timeout?: number;
}

export type HookName = keyof typeof SESSION_EVENTS;

function normalizeHookEntry(entry: HookEntry): SessionHookConfig {
  const command = entry.run.script === undefined
    ? entry.run.command
    : `node ${path.join(HOOKS_DIR, entry.run.script)}`;
  return {
    command,
    timeout: entry.run.timeout === undefined
      ? DEFAULT_TIMEOUT_MS
      : entry.run.timeout * 1_000,
  };
}

export function loadHookConfig(name: HookName): SessionHookConfig | null {
  const entries = filterHookEntries(loadHookRegistry(), { event: SESSION_EVENTS[name] });
  return entries[0] ? normalizeHookEntry(entries[0]) : null;
}

export function isOnNewHookConfigured(): boolean {
  return loadHookConfig('onNew') !== null;
}

export function isOnMessageEndHookConfigured(): boolean {
  return loadHookConfig('onMessageEnd') !== null;
}

// ── Unified hook pipeline ─────────────────────────────────────────────────────

/** Per-hook context fed to the subprocess (via stdin JSON) and the formatters. */
export interface SessionHookContext {
  channel: string;
  sessionId: string;
  sessionName: string;
  executionId?: string | null;
  profile?: string | null;
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

/** When set, the hook stdout is injected as a fresh agent turn against `targetSessionId`.
 *  All assistant output is appended into the same OutputStream so it visually
 *  continues the hook's status/preview lines. */
export interface SessionHookInject {
  targetSessionId: string;
  profileName: string | null;
  /** Session-pool key for the injected turn.
   *  - onNew: an ISOLATED key (onNewInjectSessionKey(channel)) so resuming the old session for
   *    the pre-close turn never collides with the channel's live pool slot — see the race below.
   *  - onMessageEnd: the channel itself, because the injection continues the live conversation. */
  sessionKey: string;
  /** Forwarded to runAgent as `trigger`, useful for telemetry / cost grouping. */
  trigger?: string;
}

/** Pool key for the onNew hook's injected "pre-close" turn.
 *
 *  MUST be distinct from the channel's live session-pool slot (which is keyed by the channel
 *  itself, see ClaudeAdapter / facade `sessionKey: options.channel`). Race it guards against:
 *  `!new` fires this hook fire-and-forget, then synchronously closeSession(channel) +
 *  resetChannelSession(channel). The hook's memory-write subprocess finishes LATER and injects
 *  its stdout as a final turn that RESUMES the old session. If that turn used `channel` as its
 *  pool key it would re-create (resurrect) a live session under the channel slot AFTER the reset
 *  — so the next message of the brand-new conversation (also keyed by channel) would reuse the
 *  resurrected OLD session instead of starting fresh. Routing the pre-close turn to a dedicated
 *  key keeps it off the live slot; we close that key once the turn is done. */
export function onNewInjectSessionKey(channel: string): string {
  return `${channel}::onnew-hook`;
}

/** Injected-turn dependencies — seam for unit tests (default binds the real runAgent + a
 *  backend-aware session close). */
export interface InjectDeps {
  runAgent: typeof runAgent;
  /** Close the pooled session created for the injected turn (by sessionKey). */
  closeInjectedSession: (channel: string, sessionKey: string) => void | Promise<void>;
}

const defaultInjectDeps: InjectDeps = {
  runAgent,
  closeInjectedSession: async (channel: string, sessionKey: string) => {
    try {
      await getAdapter(resolveBackendForChannel(channel) as Backend).close(sessionKey);
    } catch (e: any) {
      log.warn(`closeInjectedSession failed (${sessionKey}): ${e?.message || e}`);
    }
  },
};

/** Inject hook stdout as a fresh agent turn against `inject.targetSessionId`, routed through
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
    const handle: AgentHandle = deps.runAgent(output, {
      channel: spec.ctx.channel,
      sessionId: inject.targetSessionId,
      sessionKey: inject.sessionKey,
      isUserInitiated: false,
      profileName: inject.profileName,
      trigger: inject.trigger ?? `hook:${spec.name}`,
      onAssistantMessage: (text: string) => stream.emitText(text),
    });
    await handle.promise;
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
    CORTEX_HOOK_SESSION_NAME: ctx.sessionName,
    CORTEX_HOOK_TRIGGER: name === 'onNew' ? 'new' : 'messageEnd',
  };
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
    sessionName: ctx.sessionName,
    executionId: ctx.executionId ?? null,
    profile: ctx.profile ?? null,
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
  const cfg = loadHookConfig(spec.name);
  if (!cfg) return;
  stream.emitText(spec.format.statusLine());
  const results = await emitCortexEvent(
    SESSION_EVENTS[spec.name],
    buildHookPayload(spec.name, spec.ctx),
    { env: buildHookEnv(spec.name, spec.ctx) },
  );
  let handled = false;
  for (const emitted of results) {
    const result = asSessionHookResult(emitted);
    if (!result) continue;
    handled = true;
    await handleHookResult(result, spec, stream, deps, emitted.id);
  }
  if (!handled) await flushHookStream(stream, cfg.command, 'no-result');
}

// ── onNew (pre-close) entry points ────────────────────────────────────────────

const ONNEW_FORMAT: SessionHookFormat = {
  statusLine: () => `${Icons.hook} Running \`!new\` hook…`,
  previewLine: (out) => {
    const preview = out.length > 80 ? out.slice(0, 80) + '…' : out;
    return `${Icons.hook} ${preview}`;
  },
  errorLine: (err) => `${Icons.warning} \`!new\` hook failed: ${err}`,
  emptyLine: () => `${Icons.hook} hook returned empty output — nothing to inject.`,
};

const ONMESSAGEEND_FORMAT: SessionHookFormat = {
  statusLine: () => `${Icons.hook} Checking for unreleased locks…`,
  previewLine: (out) => {
    const preview = out.length > 80 ? out.slice(0, 80) + '…' : out;
    return `${Icons.hook} ${preview}`;
  },
  errorLine: (err) => `${Icons.warning} Lock check failed: ${err}`,
  // onMessageEnd is silent on empty output — the common case is "nothing to remind".
  emptyLine: () => null,
};

/** Resolve the Slack thread anchor for a fresh onNew vm:
 *    1. Caller-supplied threadAnchorId (e.g. user typed !new in-thread).
 *    2. Last turn's statusMessageTs from the conversation ledger.
 *    3. null → vm starts a top-level message and self-anchors. */
async function resolveOnNewThreadAnchor(channel: string, threadAnchorId?: string | null): Promise<string | null> {
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

/** Resolve the profile name to use when injecting the onNew hook's stdout as a fresh
 *  agent turn. Priority order:
 *    1. session-registry (per-session truth — correct for thread-spawned sessions whose
 *       profile is NOT mirrored into the channel-level conversation-ledger).
 *    2. conversation-ledger (channel-level fallback — correct for user-conversation
 *       sessions where the registry may lack a profileName-bearing record).
 *
 *  The two sources can disagree on a channel that hosts both kinds of session — e.g.
 *  a thread session running profile `deepseek-pro` while the user's main conversation
 *  is on profile `plan`. Reading from the ledger alone causes Cortex to resume the
 *  thread session with the wrong profile, which routes through the wrong gateway mode
 *  and triggers Anthropic's "Invalid signature in thinking block" 400.
 *
 *  Exported (rather than inlined) so the priority logic is unit-testable in isolation
 *  without spinning up the real repo singletons. */
export interface ProfileLookupDeps {
  lookupRegistryProfile: (sessionId: string) => Promise<string | null>;
  lookupLedgerProfile:   (channel: string)   => Promise<string | null>;
}

export async function resolveOnNewProfileName(
  channel: string,
  sessionId: string,
  deps: ProfileLookupDeps,
): Promise<string | null> {
  const fromRegistry = await deps.lookupRegistryProfile(sessionId);
  if (fromRegistry) return fromRegistry;
  return deps.lookupLedgerProfile(channel);
}

/** Default binding of the registry lookup — composes lookupBySessionId + lookupSession.
 *  Extracted so prepareOnNewRun's call site stays one line and tests can swap in fakes. */
async function defaultLookupRegistryProfile(sessionId: string): Promise<string | null> {
  const name = await sessionStore.lookupBySessionId(sessionId);
  if (!name) return null;
  const record = await sessionStore.lookupSession(name);
  return record?.profileName ?? null;
}

async function defaultLookupLedgerProfile(channel: string): Promise<string | null> {
  const conv = await conversationLedger.getConversation(channel);
  return conv?.profileName ?? null;
}

/** Build the onNew SessionHookSpec + a fresh stream. Returns null when the hook isn't
 *  configured or there's no live session to capture context from. */
async function prepareOnNewRun(
  channel: string,
  adapter: PlatformAdapter,
  threadAnchorId?: string | null,
): Promise<{ spec: SessionHookSpec; stream: OutputStream } | null> {
  if (!isOnNewHookConfigured()) return null;

  const backend = resolveBackendForChannel(channel);
  const sessionId = await getSessionAsync(channel, backend);
  if (!sessionId) {
    log.info('onNew hook skipped: no active session for channel', channel);
    return null;
  }
  const sessionName = (await sessionStore.lookupBySessionId(sessionId)) || sessionId.slice(0, 8);

  // Resolve profile BEFORE handleNewCmd clears the ledger (sync, runs after this fn returns).
  // Registry is the per-session truth; ledger is the channel-level fallback.
  const profileName = await resolveOnNewProfileName(channel, sessionId, {
    lookupRegistryProfile: defaultLookupRegistryProfile,
    lookupLedgerProfile:   defaultLookupLedgerProfile,
  });

  const anchor = await resolveOnNewThreadAnchor(channel, threadAnchorId);
  const stream = adapter.openOutputStream({ type: 'interactive-reply', conduit: channel, sessionId: '' }, { threadId: anchor });

  const spec: SessionHookSpec = {
    name: 'onNew',
    ctx: { channel, sessionId, sessionName, profile: profileName },
    format: ONNEW_FORMAT,
    inject: {
      targetSessionId: sessionId,
      profileName,
      sessionKey: onNewInjectSessionKey(channel),
      trigger: 'hook:onNew',
    },
  };

  return { spec, stream };
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

/** Synchronous variant of fireAndForgetPreCloseHook — awaits the hook to completion.
 *  Reserved for cases where the caller wants to block on the !new pipeline (e.g.
 *  test harness, scripted teardown). */
export async function runPreCloseHook(
  channel: string,
  adapter: PlatformAdapter,
  threadAnchorId?: string | null,
): Promise<void> {
  const prepared = await prepareOnNewRun(channel, adapter, threadAnchorId);
  if (!prepared) return;
  await runSessionHook(prepared.spec, prepared.stream);
}

// ── onMessageEnd entry point ─────────────────────────────────────────────────

export interface OnMessageEndArgs {
  channel: string;
  sessionId: string;
  sessionName: string;
  executionId: string;
  profile?: string | null;
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
      sessionName: args.sessionName,
      executionId: args.executionId,
      profile: args.profile ?? null,
    },
    format: ONMESSAGEEND_FORMAT,
    inject: {
      targetSessionId: args.sessionId,
      profileName: args.profile ?? null,
      // onMessageEnd continues the live conversation — keep it on the channel pool slot.
      sessionKey: args.channel,
      trigger: 'hook:onMessageEnd',
    },
  };
  await runSessionHook(spec, args.stream);
}
