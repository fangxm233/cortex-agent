import { randomUUID } from 'node:crypto';
import { withoutSubagentTools } from '@core/mcp-tool-gate.js';
import { createLogger } from '@core/log.js';
import type { AgentResult } from '@core/types/agent-types.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../../../agent-adapter/capabilities.js';
import type { Backend } from '../../../agent-adapter/types.js';
import type { SubagentNotice } from '@core/agents/subagent/types.js';
import { parseModelSpec, selectChildModel, type ModelSpec } from '@core/agents/subagent/model-spec.js';
import { noticesFor } from '../../../agent-adapter/pi/child-events.js';
import { getPiEngineAdapter } from '../../runs/adapters.js';
import { resolvePiAccountRoute } from '../../connections/pi-account-dir.js';
import { type AgentRole } from '@core/agents/roles.js';
import { resolveDaemonSelection } from '../model-selection.js';
import type { EngineSelection } from '../engine-selection.js';
import { startRun } from '../../runs/service.js';
import { engines } from '../../runs/engines.js';
import { fromRole } from '../../runs/spec-loader.js';
import type { RunObserver, RunRequest } from '../../runs/request.js';
import type { RunEvent } from '../../runs/events.js';
import { emptyUsage } from '@core/agents/subagent/usage.js';
import { openBundledMcpServer } from '../../mcp/bundled-server.js';
import { cleanRunPolicy } from '../../runs/clean-mode.js';
import type {
  ChildAccumulator, ChildEventForwarder, SubagentResult, SubagentTask, SubagentUsage,
} from '@core/agents/subagent/types.js';

const log = createLogger('subagent-runner');

/** Which MCP surface a one-shot child is allowed. `direct` is what an ordinary turn gets. */
const CHILD_MCP_BUNDLES = ['cortex-core', 'cortex-ext'];

/** The delegating turn's materialized engine context. */
export interface SubagentParentContext {
  backend: Backend;
  /** The parent run's connection. A same-backend Claude child reuses it verbatim; a PI child on the
   *  parent's provider runs on the parent's account. */
  connection?: string | null;
  provider?: string | null;
  model?: string | null;
  channel?: string;
  project?: string;
  /** The delegating session's TRACK id (`CORTEX_SESSION_ID`). A child is not that session — its own
   *  `session.sessionId` stays null — but the money it spends belongs to that conversation, so this
   *  rides along as the execution record's `ownerSessionId` for the session-totals roll-up. Absent
   *  when the parent has no session identity (a PI cross-backend child, a fixture). */
  sessionId?: string | null;
  /** The parent session's environment, inherited by a nested `pi` child. */
  env?: NodeJS.ProcessEnv;
}

export interface SubagentRunRequest {
  task: SubagentTask;
  role: AgentRole;
  backend: Backend;
  cwd: string;
  /** A clean child's workspace (then also its `cwd`); null or absent for an ordinary child. */
  workspace?: string | null;
  /** Attribution block key, `${parentToolUseId}#${childIndex}`. */
  ref: string;
  parent: SubagentParentContext;
  signal?: AbortSignal;
  onNotice?: (notice: SubagentNotice) => void;
}

/** Task model → role model, and nothing else: a Claude child applies the parent's model itself. */
function resolveSpec(request: SubagentRunRequest): ModelSpec {
  return parseModelSpec(request.task.model?.trim() || request.role.model?.trim());
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

async function runPiSubagent(request: SubagentRunRequest): Promise<SubagentResult> {
  // Dynamically imported: the PI SDK must not load into a daemon whose parent turn is Claude-only.
  const [{ runPiChild }, { childExtensions }] = await Promise.all([
    import('../../../agent-adapter/pi/child-runner.js'),
    import('../../../agent-adapter/pi/tool-shims.js'),
  ]);
  const model = piChildModel(request);
  const adapter = getPiEngineAdapter();
  const agentDir = piChildAccountDir(request.parent, model) ?? adapter.agentDir;
  try {
    adapter.ensureCatalog(agentDir);
  } catch (error) {
    log.warn(`Could not write the PI catalog for a pi subagent: ${(error as Error).message}`);
  }
  return runPiChild({
    task: request.task,
    role: request.role,
    cwd: request.cwd,
    workspace: request.workspace ?? null,
    agentDir,
    parentEnv: request.parent.env ?? process.env,
    model,
    // A Claude parent delegating to a `pi` child builds the child outside any PI session, so the
    // Cortex bundle opener is bound here rather than inherited from a parent session (D10).
    childExtensions: (env) => childExtensions(env, openBundledMcpServer),
    signal: request.signal,
    forward: piForwarder(request),
  });
}

/** A PI parent on an account keeps a child on the same provider on that account; any other child
 *  runs on the provider's default login. */
function piChildAccountDir(parent: SubagentParentContext, model: ModelSpec): string | undefined {
  if (parent.backend !== 'pi' || !parent.connection) return undefined;
  const provider = model.provider ?? parent.provider ?? null;
  if (provider !== parent.provider) return undefined;
  return resolvePiAccountRoute({ backend: 'pi', provider, connection: parent.connection })?.agentDir;
}

/**
 * A PI child's model: the task's or role's spec as written (PI resolves it), else a PI parent's own
 * model. A Claude parent's model means nothing to PI, so its child without a spec starts where a
 * switch to PI would: the PI default, else the first PI favorite.
 */
function piChildModel(request: SubagentRunRequest): ModelSpec {
  const piParent = request.parent.backend === 'pi' ? request.parent : null;
  const named = selectChildModel(request.task, request.role, piParent);
  if (named.model) return named;
  const resolution = resolveDaemonSelection({}, { backend: 'pi' });
  if (resolution.ok === false) return {};
  const { provider, model } = resolution.selection;
  return { model, ...(provider ? { provider } : {}) };
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

/** The Claude parent's own selection, when there is one to fall back to. */
function claudeParentSelection(parent: SubagentParentContext): EngineSelection | null {
  if (parent.backend !== 'claude' || !parent.model) return null;
  return { backend: 'claude', provider: null, model: parent.model, thinking: null, connection: parent.connection ?? null };
}

/**
 * The child model comes from the task or role, then the parent's own model when that parent is
 * Claude, and finally the configured Claude default. The connection follows the Claude parent while
 * it serves the child's model; otherwise it is computed for that model. The child remains a
 * one-shot run, with no thinking level unless the spec names one.
 */
function claudeChildConfig(request: SubagentRunRequest, spec: ModelSpec): EngineSelection {
  const parent = claudeParentSelection(request.parent);
  const resolution = resolveDaemonSelection({ request: parent }, {
    ...(parent ? {} : { backend: 'claude' as const }),
    ...(spec.model ? { model: spec.model } : {}),
    thinking: spec.thinking ?? null,
  });
  if (resolution.ok === false) {
    throw new Error(`A claude subagent cannot run (${resolution.reason}); favorite a Claude model or fix its thinking level.`);
  }
  return resolution.effective;
}

/**
 * A child's own pool slot, never the parent's. Keying a child on the parent's channel put it on
 * the slot the parent's interactive session already occupies (`engineKey === channel` there too),
 * and a child's spec identity always differs — leaf tool surface, role prompt, own allowlist — so
 * `SessionEngines.acquireClaude` retired the LIVE PARENT to make room, killing it mid-turn 30s
 * later. Parallel children stomped on each other the same way. The channel stays the prefix so
 * channel-wide sweeps (`closeByPrefix`) still reach children.
 */
function childEngineKey(request: SubagentRunRequest, runId: string): string {
  return `${request.parent.channel || 'default'}#sub:${runId}`;
}

/** The request a Claude child runs under. A frozen one-shot role: no session to resume, no
 *  hooks, no ambient rules, no transcript log, and a leaf tool surface. A clean child also runs in
 *  its workspace without project context files, the workspace section after its role prompt. */
function claudeChildRequest(request: SubagentRunRequest, config: EngineSelection): RunRequest {
  const child = baseClaudeChildRequest(request, config);
  if (!request.workspace) return child;
  return { ...child, cwd: request.workspace, policy: cleanRunPolicy(child.policy) };
}

function baseClaudeChildRequest(request: SubagentRunRequest, config: EngineSelection): RunRequest {
  const mcpToolAllowlist = withoutSubagentTools(undefined, CHILD_MCP_BUNDLES);
  const runId = randomUUID();
  return {
    runId,
    session: {
      sessionId: null,
      backendSessionId: null,
      engineKey: childEngineKey(request, runId),
    },
    selection: config,
    // The child runs where the caller asked (the parent's workspace), not where the server lives.
    cwd: request.cwd,
    spec: fromRole(request.role, 'claude', { mcpAllowlist: mcpToolAllowlist ?? null }),
    prompt: { text: `Task: ${request.task.prompt}`, attachments: [] },
    context: {
      channel: request.parent.channel ?? '',
      project: request.parent.project ?? 'general',
      trigger: 'subagent',
      // Attribution only: `session.sessionId` above stays null (the child is not the session), so
      // every last-run resolver keeps ignoring this record while its cost still lands on the
      // conversation that paid for it.
      ownerSessionId: request.parent.sessionId ?? null,
      executionKind: 'local',
      isUserInitiated: false,
      scheduleTaskId: null,
    },
    policy: {
      // A child never waits inline for background work.
      background: 'none',
      // A child's own spend is recorded like any other run's.
      recordCost: true,
      hooks: false,               // disableHooks: true
      loadRules: false,           // loadCortexRules: false
      mcpComposition: 'direct',
      mcpToolAllowlist,
      captureTranscripts: false,  // captureTranscriptLogs: false
    },
  };
}

/**
 * Retire the child's process once its run is terminal. A child's key is unique to the run, so
 * nothing will ever acquire it again — without this the finished one-shot session would sit in
 * the pool holding a live CLI until `IDLE_SESSION_TIMEOUT` (65 min) swept it. `settled`, not
 * `result`: the background phase, if any, owns the process after the foreground turn.
 */
function releaseChildEngine(settled: Promise<unknown>, engineKey: string): void {
  void settled
    .catch(() => undefined)
    .then(() => engines.close(engineKey))
    .catch((error) => log.warn(
      `releasing child engine ${engineKey} failed: ${(error as Error).message}`,
    ));
}

async function runClaudeSubagent(request: SubagentRunRequest): Promise<SubagentResult> {
  const spec = resolveSpec(request);
  const config = claudeChildConfig(request, spec);
  if (!config.model) throw new Error('A claude subagent needs a model: set one on the task or the role.');
  const childRequest = claudeChildRequest(request, config);
  const run = startRun(childRequest, request.onNotice ? [claudeNoticeObserver(request)] : []);
  releaseChildEngine(run.settled, childRequest.session.engineKey);
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
    ...(request.task.clean ? { clean: true } : {}),
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
          ...(event.images?.length ? { images: event.images } : {}),
        });
      }
    },
  };
}

/** Internals exposed for tests only. */
export const _test = { claudeChildConfig, claudeChildRequest, claudeNoticeObserver };
