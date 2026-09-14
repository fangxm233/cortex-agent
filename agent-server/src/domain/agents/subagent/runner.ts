// input:  one resolved task + role, the delegating parent's context, an abort signal
// output: one SubagentResult, from a nested PI session or a frozen one-shot Claude run
// pos:    Backend dispatch for a single subagent child
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import { withoutSubagentTools } from '@core/mcp-tool-gate.js';
import { createLogger } from '@core/log.js';
import type { AgentResult } from '@core/types/agent-types.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../../../agent-adapter/capabilities.js';
import type { Backend } from '../../../agent-adapter/types.js';
import type { SubagentNotice } from '../../../agent-adapter/pi/event-parser.js';
import { noticesFor } from '../../../agent-adapter/pi/child-events.js';
import { getPiEngineAdapter } from '../../runs/adapters.js';
import { resolveRunConfig } from '../../runs/config-resolver.js';
import { GATEWAY_URL } from '../../costs/gateway-manager.js';
import { type AgentRole } from '@core/agents/roles.js';
import { buildPiGatewaySubPath } from '../../runs/engine-spec.js';
import type { RunAttemptConfig } from '../profile-manager.js';
import type { ResolvedProfileConfig } from '../profile-manager.js';
import { startRun } from '../../runs/service.js';
import { fromRole } from '../../runs/spec-loader.js';
import type { RunObserver, RunRequest } from '../../runs/request.js';
import type { RunEvent } from '../../runs/events.js';
import { emptyUsage } from '@core/agents/subagent/usage.js';
import { openBundledMcpServer } from '../../mcp/bundled-server.js';
import type {
  ChildAccumulator, ChildEventForwarder, SubagentResult, SubagentTask, SubagentUsage,
} from '@core/agents/subagent/types.js';

const log = createLogger('subagent-runner');

/** Which MCP surface a one-shot child is allowed. `direct` is what an ordinary turn gets. */
const CHILD_MCP_BUNDLES = ['cortex-core', 'cortex-tasks', 'cortex-manager-qa', 'cortex-ext'];

/** What the delegating turn already resolved. A child inherits routing from here — never a profile. */
export interface SubagentParentContext {
  backend: Backend;
  /** The parent run's resolved gateway route. A `claude` child reuses it verbatim. */
  mode?: string | null;
  provider?: string | null;
  model?: string | null;
  channel?: string;
  project?: string;
  cwd?: string;
  /** The parent session's environment, inherited by a nested `pi` child. */
  env?: NodeJS.ProcessEnv;
}

export interface SubagentRunRequest {
  task: SubagentTask;
  role: AgentRole;
  backend: Backend;
  cwd: string;
  /** Attribution block key, `${parentToolUseId}#${childIndex}`. */
  ref: string;
  parent: SubagentParentContext;
  signal?: AbortSignal;
  onNotice?: (notice: SubagentNotice) => void;
}

export interface ModelSpec {
  provider?: string;
  model?: string;
  thinking?: string;
}

/**
 * `provider/model[:thinking]`, every part optional.
 *
 * A `claude` child keeps only `model` and `thinking` — a bare Claude model id has no provider
 * segment, so a spec carrying one was written for the other backend and its provider is dropped
 * rather than smuggled into `--model`.
 */
export function parseModelSpec(spec: string | undefined): ModelSpec {
  const trimmed = spec?.trim();
  if (!trimmed) return {};
  const colon = trimmed.lastIndexOf(':');
  const thinking = colon > 0 ? trimmed.slice(colon + 1).trim() || undefined : undefined;
  const rest = colon > 0 ? trimmed.slice(0, colon) : trimmed;
  const slash = rest.indexOf('/');
  if (slash < 0) return { model: rest || undefined, thinking };
  return {
    provider: rest.slice(0, slash) || undefined,
    model: rest.slice(slash + 1) || undefined,
    thinking,
  };
}

/**
 * Task model → role model, and nothing else. The parent's own model is deliberately NOT a fallback
 * here: it is only meaningful to a child on the same backend, so each branch applies it itself.
 */
function resolveSpec(request: SubagentRunRequest): ModelSpec {
  return parseModelSpec(request.task.model?.trim() || request.role.model?.trim());
}

/** The parent's model, but only when the child runs the same backend — a Claude model id means
 *  nothing to PI, and a PI `provider/model` means nothing to Claude. */
function parentModel(request: SubagentRunRequest): ModelSpec {
  if (request.parent.backend !== request.backend) return {};
  return {
    provider: request.parent.provider ?? undefined,
    model: request.parent.model ?? undefined,
  };
}

/**
 * Whether a backend can host a delegated child (plan §6.3). Declared as a capability rather than
 * inferred from the backend name, so the dispatch below and every caller that wants to reject early
 * agree on one answer.
 */
export function supportsSubagents(backend: Backend): boolean {
  return !!CAPABILITIES_BY_BACKEND[backend]?.has(Capability.Subagents);
}

export async function runSubagent(request: SubagentRunRequest): Promise<SubagentResult> {
  if (request.signal?.aborted) throw new Error('Subagent was aborted.');
  if (!supportsSubagents(request.backend)) {
    throw new Error(`Backend "${request.backend}" cannot run subagents.`);
  }
  return request.backend === 'pi' ? runPiSubagent(request) : runClaudeSubagent(request);
}

// ─── pi child ─────────────────────────────────────────────────────

/**
 * Route resolution for a `pi` child, in order: the role's own `mode:`, then the parent's route when
 * the parent is a PI run on this same provider, and finally the provider's own name — which is the
 * convention `profiles.json` already follows (`provider: deepseek` pairs with `mode: deepseek`).
 */
function resolvePiMode(request: SubagentRunRequest, provider: string): string {
  if (request.role.mode) return request.role.mode;
  const parent = request.parent;
  if (parent.backend === 'pi' && parent.provider === provider && parent.mode) return parent.mode;
  return provider;
}

async function runPiSubagent(request: SubagentRunRequest): Promise<SubagentResult> {
  // Dynamically imported: the PI SDK must not load into a daemon whose parent turn is Claude-only.
  const [{ runPiChild }, { childExtensions }] = await Promise.all([
    import('../../../agent-adapter/pi/child-runner.js'),
    import('../../../agent-adapter/pi/tool-shims.js'),
  ]);
  const inherited = parentModel(request);
  const spec = resolveSpec(request);
  const provider = spec.provider ?? inherited.provider;
  const adapter = getPiEngineAdapter();
  if (provider) {
    const mode = resolvePiMode(request, provider);
    try {
      adapter.ensureProviderRouting({
        provider,
        gatewayPath: buildPiGatewaySubPath(mode, provider) ?? null,
        gatewayBaseUrl: GATEWAY_URL,
        model: spec.model,
      });
    } catch (error) {
      log.warn(`Could not route provider ${provider} for a pi subagent: ${(error as Error).message}`);
    }
  }
  const model = spec.model ?? inherited.model;
  return runPiChild({
    task: request.task,
    role: request.role,
    cwd: request.cwd,
    agentDir: adapter.agentDir,
    parentEnv: request.parent.env ?? process.env,
    fallbackModel: model ? { id: model, provider } : null,
    // A Claude parent delegating to a `pi` child builds the child outside any PI session, so the
    // Cortex bundle opener is bound here rather than inherited from a parent session (D10).
    childExtensions: (env) => childExtensions(env, openBundledMcpServer),
    signal: request.signal,
    forward: piForwarder(request),
  });
}

/** A nested PI session emits PI-shaped records; translate them with PI's own notice builder, the
 *  same one the in-process shim uses, so a cross-backend child renders identically to a native one. */
function piForwarder(request: SubagentRunRequest): ChildEventForwarder | undefined {
  const onNotice = request.onNotice;
  if (!onNotice) return undefined;
  const { ref, task } = request;
  let promptSent = false;
  return (event: Record<string, unknown>, accumulator: ChildAccumulator): void => {
    const notices = noticesFor(ref, task, accumulator, event);
    for (const notice of notices) {
      try {
        onNotice(promptSent ? notice : { ...notice, prompt: task.prompt });
        promptSent = true;
      } catch { /* attribution is best-effort */ }
    }
  };
}

// ─── claude child ─────────────────────────────────────────────────

/**
 * No profile is consulted for the CHILD (plan §3.2): the model comes from the task or the role,
 * falling back to the parent's own when the parent is itself Claude. The last resort used to be
 * the daemon's global Claude model/mode; with D5 there is no global, so it is the profile the
 * parent's channel resolves to — the same answer whenever that global was ever correct.
 * The gateway `mode` follows the same rule, so a child bills through the parent's route.
 */
function claudeChildConfig(request: SubagentRunRequest, spec: ModelSpec): RunAttemptConfig {
  const sameBackend = request.parent.backend === 'claude';
  const channelDefault = resolveRunConfig({ channel: request.parent.channel }).profile;
  return {
    model: spec.model ?? (sameBackend ? request.parent.model : null) ?? channelDefault.model,
    backend: 'claude',
    mode: (sameBackend ? request.parent.mode : null) ?? channelDefault.mode,
    provider: null,
    extraEnv: {},
    extraOption: {},
    claudeBackend: 'print',
    thinking: spec.thinking ?? null,
  };
}

/** Wrap the child's resolved config as the run's profile: the run layer plans its attempt chain
 *  from `request.profile`, so a synthesized single-attempt profile is how a role/task model reaches
 *  the spawn without any named profile being consulted. */
function claudeChildProfile(config: RunAttemptConfig): ResolvedProfileConfig {
  return {
    // Unnamed on purpose: no profile was consulted for the child, so none is attested to it.
    name: '',
    model: config.model,
    backend: config.backend,
    mode: config.mode,
    provider: config.provider ?? null,
    extraEnv: config.extraEnv ?? {},
    extraOption: config.extraOption ?? {},
    claudeBackend: config.claudeBackend ?? 'print',
    thinking: config.thinking ?? null,
    maxOutputTokens: config.maxOutputTokens ?? null,
    fallback: [],
  };
}

/** The RunRequest equivalent of the legacy `claudeChildOptions`. A frozen one-shot role: no
 *  session to resume, no hooks, no ambient rules, no transcript log, and a leaf tool surface. */
function claudeChildRequest(request: SubagentRunRequest, config: RunAttemptConfig): RunRequest {
  const mcpToolAllowlist = withoutSubagentTools(undefined, CHILD_MCP_BUNDLES);
  return {
    runId: randomUUID(),
    session: {
      sessionId: null,
      backendSessionId: null,
      // The legacy one-shot run set no session key, so the spec builder resolved
      // `options.channel || 'default'`.
      engineKey: request.parent.channel || 'default',
      sessionName: null,
    },
    profile: claudeChildProfile(config),
    // The child runs where the caller asked (the parent's workspace), not where the server lives.
    cwd: request.cwd,
    spec: fromRole(request.role, 'claude', { mcpAllowlist: mcpToolAllowlist ?? null }),
    prompt: { text: `Task: ${request.task.prompt}`, attachments: [] },
    context: {
      channel: request.parent.channel ?? '',
      project: request.parent.project ?? 'general',
      trigger: 'subagent',
      executionKind: 'local',
      isUserInitiated: false,
      commissionMode: false,
      commissionTools: false,
      scheduleTaskId: null,
    },
    policy: {
      // Legacy `awaitBackground` was undefined with no threadId -> no inline wait.
      background: 'none',
      // The legacy default (undefined) still recorded cost.
      recordCost: true,
      hooks: false,               // disableHooks: true
      loadRules: false,           // loadCortexRules: false
      mcpComposition: 'direct',
      mcpToolAllowlist,
      browserCdpEndpoint: null,
      captureTranscripts: false,  // captureTranscriptLogs: false
    },
  };
}

async function runClaudeSubagent(request: SubagentRunRequest): Promise<SubagentResult> {
  const spec = resolveSpec(request);
  const config = claudeChildConfig(request, spec);
  if (!config.model) throw new Error('A claude subagent needs a model: set one on the task or the role.');
  const run = startRun(claudeChildRequest(request, config), request.onNotice ? [claudeNoticeObserver(request)] : []);
  const onAbort = (): void => { run.cancel('user'); };
  request.signal?.addEventListener('abort', onAbort, { once: true });
  let result: AgentResult;
  try {
    result = await run.result;
  } finally {
    request.signal?.removeEventListener('abort', onAbort);
  }
  if (request.signal?.aborted) throw new Error('Subagent was aborted.');
  return claudeResult(request, result, config.model);
}

function claudeUsage(result: AgentResult): SubagentUsage {
  const reported = result.reportedAccounting;
  const usage = emptyUsage();
  usage.input = reported?.inputTokens ?? 0;
  usage.output = reported?.outputTokens ?? 0;
  usage.cacheRead = reported?.cacheReadTokens ?? 0;
  usage.cacheWrite = reported?.cacheCreationTokens ?? 0;
  usage.cost = result.total_cost_usd ?? 0;
  usage.turns = result.num_turns ?? 0;
  return usage;
}

function claudeResult(
  request: SubagentRunRequest,
  result: AgentResult,
  requestedModel: string,
): SubagentResult {
  const failed = result.rateLimited || (!result.finalOutput && !!result.rateLimitMessage);
  return {
    description: request.task.description,
    prompt: request.task.prompt,
    subagentType: request.task.subagent_type,
    output: result.finalOutput ?? '',
    usage: claudeUsage(result),
    model: result.reportedAccounting?.model ?? requestedModel,
    backend: 'claude',
    ...(failed ? { stopReason: 'error', errorMessage: result.rateLimitMessage ?? 'Subagent run failed.' } : {}),
  };
}

/** Live attribution: the child's own run events, re-stamped with the parent's block key. */
function claudeNoticeObserver(request: SubagentRunRequest): RunObserver {
  const onNotice = request.onNotice!;
  const ref = request.ref;
  const base = {
    ref, type: request.task.subagent_type, description: request.task.description,
    backend: 'claude' as const,
  };
  let model: string | null = null;
  let promptSent = false;
  const send = (notice: SubagentNotice): void => {
    try {
      onNotice(promptSent ? notice : { ...notice, prompt: request.task.prompt });
      promptSent = true;
    } catch { /* attribution is best-effort */ }
  };
  return {
    onEvent(event: RunEvent): void {
      // A child's own events carry no subagent attribution — it has no delegation tools — so an
      // attributed one was pushed into this run's stream from outside, by `parentNoticeSink`. It
      // belongs to a nesting we did not create, and forwarding it would send it straight back to
      // the sink that pushed it: notice → ingestExternal → event → notice, an unbounded loop that
      // starves the event loop and takes the whole daemon's I/O down with it. Drop it.
      if ('subagent' in event && event.subagent) return;
      if (event.type === 'assistant_text') {
        if (event.model) model = event.model;
        if (event.text) send({ ...base, model, kind: 'assistant_text', text: event.text });
        return;
      }
      if (event.type === 'tool_use') {
        send({
          ...base, model, kind: 'tool_use',
          toolUseId: `${ref}:${event.toolUseId}`, name: event.name, input: event.input,
        });
        return;
      }
      if (event.type === 'tool_result') {
        send({
          ...base, model, kind: 'tool_result',
          toolUseId: `${ref}:${event.toolUseId}`, ok: event.ok, content: event.content,
        });
      }
    },
  };
}

/** Internals exposed for tests only. */
export const _test = { claudeNoticeObserver };
