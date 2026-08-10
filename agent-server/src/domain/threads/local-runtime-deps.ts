// input:  a port bundle installed on the async-local runtime scope
// output: LocalThreadRuntimeDeps, the scope accessors, and I3's fail-closed proxy
// pos:    Dependency boundary for daemon-free benchmark threads
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// This module holds the interface and the scope only. The daemon-side default factory lives in
// `./local-runtime-defaults.js`; standalone composition supplies structural ports here without
// importing host singleton stores. Reusable type contracts may cross domain boundaries, while an
// absent runtime scope still fails closed instead of selecting daemon defaults.

import type { RunningExecutions } from '../../core/running-executions.js';
import type { AgentHandle } from '../../core/types/agent-types.js';
import type {
  AgentDefinition, AgentSlotConfig, RunThreadOptions, ThreadHookConfig, ThreadId, ThreadMetadata,
  ThreadRecord, ThreadTemplate, TransitionResult,
} from '../../core/types/thread-types.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import type { RunAgentOptions } from '../agents/spawn-config.js';
import {
  getLocalThreadRuntimeScope, withLocalThreadRuntimeScope,
  type LocalThreadRuntimeScope,
} from './local-runtime-scope.js';

/** §7.4 code 32, registered in `BENCHMARK_FAILURES` (domain/benchmark/resolved-policy.ts). The
 *  number is repeated rather than imported because §18 G5-P1 confines this module to modules that
 *  reach no prohibited target, and the registry is not one; the two are pinned together by
 *  tests/domain/benchmark/port-scope-fence.test.ts. */
export const PORT_SCOPE_ESCAPED = 'port_scope_escaped';
export const PORT_SCOPE_ESCAPED_CODE = 32;

/** Raised when a composite operation ran outside `withLocalThreadRuntimeDeps`, so the scope was
 *  empty and the daemon singleton fallback would have been used (§7.1 I3). Class R: the trial is
 *  already executing, so §4.5's finalization obligation applies, not §2.6's pre-start rules. */
export class PortScopeEscapedError extends Error {
  readonly reason = PORT_SCOPE_ESCAPED;
  readonly code = PORT_SCOPE_ESCAPED_CODE;
  readonly failureClass = 'R';

  constructor(readonly port: string) {
    super(`${PORT_SCOPE_ESCAPED}: ${port}`);
    this.name = 'PortScopeEscapedError';
  }
}

/** §7.2 P7. The thread store as the port sees it. `get`/`getAll`/`mutate` are P7's own list;
 *  `set`, `load` and `flush` are the rest of the surface the shipped proxies at `runner.ts:80` and
 *  `benchmark-local-thread-orchestrator.ts:117` already read through this field. */
export interface ThreadStorePort {
  get(id: ThreadId): ThreadRecord | null;
  getAll(): ThreadRecord[];
  set(record: ThreadRecord): Promise<void>;
  mutate(id: ThreadId, fn: (thread: ThreadRecord) => void): Promise<void>;
  load(): void;
  flush(): Promise<void>;
}

/** §7.2 P7. */
export interface SessionStorePort {
  generateSessionName(): Promise<string>;
  registerSession(name: string, opts: {
    sessionId: string;
    channel: string;
    backend: string;
    kind: 'local' | 'scheduled';
    origin?: 'direct' | 'thread' | 'scheduled';
    projectId?: string;
    label?: string | null;
    profileName?: string | null;
    backendSessionId?: string | null;
    scheduleId?: string | null;
  }): Promise<void>;
  flush(): Promise<void>;
}

export interface LocalExecutionStartInput {
  kind?: string;
  channel?: string | null;
  project?: string;
  trigger?: string;
  backend?: string;
  billingMode?: string;
  sessionId?: string | null;
  label?: string | null;
  scheduleTaskId?: string | null;
  threadId?: string | null;
  agentSlotId?: string | null;
}

export interface ExecutionOutcomeMetrics {
  costUsd?: number | null;
  numTurns?: number | null;
  durationS?: number | null;
  finalOutput?: string | null;
  error?: string | null;
}

/** §7.2 P7. The execution record stays opaque because no port method reads its concrete host
 *  store type; `local-runtime-defaults.ts` adapts daemon records behind this interface. */
export interface ExecutionStorePort {
  startLocalExecution(input: LocalExecutionStartInput): unknown;
  completeExecution(id: string, metrics?: ExecutionOutcomeMetrics): unknown;
  cancelExecution(id: string, metrics?: ExecutionOutcomeMetrics): unknown;
  failExecution(id: string, metrics?: ExecutionOutcomeMetrics): unknown;
  load(): void;
  flush(): Promise<void>;
}

export interface ExecutionTeardownInput {
  executionId: string | null;
  status: 'completed' | 'failed' | 'cancelled';
  result?: { total_cost_usd?: number; num_turns?: number; finalOutput?: string | null } | null;
  error?: { message?: string } | null;
  durationS: number;
  costUsd?: number;
}

/** §7.2 P7. The daemon's own lock release is already a no-op for local runs
 *  (`local-runtime-defaults.ts`, `releaseExecutionLocks: () => {}`). */
export interface ExecutionLedgerPort {
  startLocalExecution(options: LocalExecutionStartInput): unknown;
  teardownExecution(input: ExecutionTeardownInput): unknown;
  releaseExecutionLocks(executionId: string | null | undefined): void;
}

/** The shape `runner.ts:131` declares, restated here because that module reaches every prohibited
 *  target and cannot be imported from the interface. */
export interface ThreadRunOutcome {
  thread: ThreadRecord;
  finalOutput: string | null;
  totalCostUsd: number;
  totalNumTurns: number;
  lastAgentResult: unknown;
  executionId: string | null;
  stopReason: Exclude<TransitionResult['reason'], 'transition'> | null;
}

/** The shape `hook-runner.ts:242` declares. Same reason. */
export interface LifecycleHookConfigsInput {
  template?: ThreadHookConfig;
  extra?: ThreadHookConfig;
}

export interface CreateThreadOptions {
  templateName?: string | null;
  agentName?: string | null;
  userMessage: string;
  userMessageTs: string;
  platformThreadId?: string | null;
  projectId?: string;
  metadata?: ThreadMetadata | null;
}

export interface LocalThreadRuntimeDeps {
  runAgent(message: string, options?: RunAgentOptions): AgentHandle;
  executionLedger: ExecutionLedgerPort;
  executionStore: ExecutionStorePort;
  sessionStore: SessionStorePort;
  threadStore: ThreadStorePort;
  liveExecutions: RunningExecutions;
  /** §7.2 P8: policy-backed implementations return the compiled value for a whitelisted key and
   *  raise `policy_reresolution_attempted` (§2.6 #23) for anything else. */
  resolveProfile(name?: string | null): ResolvedProfileConfig;
  loadTemplates(): { agents: Record<string, AgentDefinition>; templates: Record<string, ThreadTemplate> };
  getTemplate(name: string): ThreadTemplate | null;
  resolveTemplateAgents(template: ThreadTemplate): AgentSlotConfig[];
  emitLifecycleHooks(
    threadId: string,
    phase: 'start' | 'transition' | 'end',
    configs: LifecycleHookConfigsInput,
    opts: RunThreadOptions,
    previousAgent?: string,
    logSuffix?: string,
  ): Promise<void>;
  /** §7.2 P16. `EventBus | null` is what `typeof jobCtx.bus` resolved to (`job-registry.ts:27`).
   *  The daemon-free default is `null`, i.e. a daemon-free thread publishes nothing; a composite
   *  path that needs it must bind a trial bus or raise `runtime_port_unbound` (§7.4 code 31). */
  eventBus: LocalThreadRuntimeScope['eventBus'];
  createThread(channel: string, options: CreateThreadOptions): ThreadRecord;
  runThread(threadId: string, opts: RunThreadOptions): Promise<ThreadRunOutcome>;
  cancelThread(threadId: string): Promise<boolean>;
  /** §7.1 I3. Present only on a bundle that refuses the daemon singleton fallback. Daemon bundles
   *  leave it unset, which is what keeps `createLocalThreadRuntimeDeps`'s behaviour identical. */
  portScope?: 'fail-closed';
}

/** Count of fail-closed bundles currently installed. A trial's own `withLocalThreadRuntimeDeps`
 *  call is still on the stack while any of its detached callbacks run, so a positive count means
 *  "a trial is in flight" and a missing scope at that moment is an escape rather than daemon work.
 *  The daemon never increments it: `createLocalThreadRuntimeDeps` sets no `portScope`. */
let failClosedScopes = 0;

/** §7.1 I3. Marks a bundle fail-closed. The trial coordinator (§4.2 N-1) builds its
 *  `CompositeRuntimePorts` this way; nothing on the daemon path calls it. */
export function failClosedRuntimeDeps<T extends LocalThreadRuntimeDeps>(
  deps: T,
): T & { portScope: 'fail-closed' } {
  return { ...deps, portScope: 'fail-closed' };
}

export function getLocalThreadRuntimeDeps(): LocalThreadRuntimeDeps | null {
  return getLocalThreadRuntimeScope() as LocalThreadRuntimeDeps | null;
}

export function scopedLocalThreadService<T extends object>(
  fallback: T,
  select: (deps: LocalThreadRuntimeDeps) => T,
): T {
  return new Proxy(fallback, {
    get(_target, key) {
      const deps = getLocalThreadRuntimeDeps();
      // §7.1 I3: the import test alone cannot prove isolation. A module that legitimately imports
      // `threadStore` and reads it through this proxy is import-clean and still touches the host
      // store whenever the scope is missing — so in benchmark mode the fallback throws.
      if (!deps && failClosedScopes > 0) throw new PortScopeEscapedError(String(key));
      const service = deps ? select(deps) : fallback;
      const value = Reflect.get(service, key, service);
      return typeof value === 'function' ? value.bind(service) : value;
    },
  });
}

export function withLocalThreadRuntimeDeps<T>(
  deps: LocalThreadRuntimeDeps,
  action: () => Promise<T>,
): Promise<T> {
  if (deps.portScope !== 'fail-closed') return withLocalThreadRuntimeScope(deps, action);
  failClosedScopes += 1;
  let scoped: Promise<T>;
  try {
    scoped = withLocalThreadRuntimeScope(deps, action);
  } catch (error) {
    // A synchronous throw out of `action` would otherwise leave the fence armed for the life of
    // the process, and an armed fence with no trial behind it stops the daemon dispatcher.
    failClosedScopes -= 1;
    throw error;
  }
  return scoped.finally(() => { failClosedScopes -= 1; });
}
