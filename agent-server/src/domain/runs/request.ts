import type { AgentProcessSpawner, McpComposition, UserMessage } from '../../agent-adapter/types.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { ProductionBenchmarkEvidenceContext } from '@core/types/thread-types.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import type { RunEvent } from './events.js';
import type { AgentSpec } from './spec-loader.js';

/** Re-exported so `@domain/runs/request.js` stays the one import for the request contract; the
 *  shape and its loaders live in spec-loader.ts. */
export type { AgentSpec, ToolSurface } from './spec-loader.js';

/** One completed run's outcome. Aliased (not redefined) so the whole stack shares `AgentResult`. */
export type RunResult = AgentResult;

/** A fully resolved run request. No callbacks, no `[key: string]: any` — observers carry output. */
export interface RunRequest {
  runId: string;
  session: {
    /** Stable Cortex tracking id (UI-facing); null when the run has no track identity
     *  (thread hook agents in insertAgent mode). */
    sessionId: string | null;
    /** Backend resume target (Claude `--resume` / PI `--session`); null for a fresh session. */
    backendSessionId: string | null;
    /** Pool key: session id, `thr:<id>:<slot>` or `<sessionId>::hook`. */
    engineKey: string;
    sessionName: string | null;
  };
  profile: ResolvedProfileConfig;
  spec: AgentSpec;
  /** Working directory the engine runs in. Omitted (undefined) means the server's own cwd, which
   *  is what every surface except a subagent child wants. Mirrors `EngineSpec.cwd` (plan §3.3). */
  cwd?: string | null;
  /** Fully assembled user message (prompt text + attachments). */
  prompt: UserMessage;
  context: {
    channel: string;
    project: string;
    trigger: string;
    /** The session that SPAWNED this run, for a run that is not a session of its own — today only
     *  an Agent-tool child (`trigger: 'subagent'`), whose `session.sessionId` stays null so the
     *  last-run resolvers keep ignoring it. Lands on the execution record as
     *  `session.ownerSessionId` and is read only by the session-totals roll-up. */
    ownerSessionId?: string | null;
    threadId?: string | null;
    threadDepth?: number | null;
    taskId?: string | null;
    taskProject?: string | null;
    taskGeneration?: string | null;
    scheduleTaskId?: string | null;
    callbackSource?: string | null;
    executionKind: 'local' | 'dispatch' | 'scheduled';
    isUserInitiated: boolean;
    commissionMode: boolean;
  };
  policy: {
    background: 'none' | 'inline' | 'hold' | 'completion-only';
    recordCost: boolean;
    hooks: boolean;
    streamDeltas?: boolean;
    loadRules: boolean;
    /** Whether the backend loads its skill layer. Absent keeps the backend's own default (every
     *  skill it can see); false is how an agent runs with none. */
    skills?: boolean;
    /** Which setting files the backend may load beyond what Cortex passes. Absent keeps its
     *  default; `[]` loads none. */
    settingSources?: string[];
    mcpComposition: McpComposition;
    /** Legacy thread-surface selector: only consulted when `mcpComposition` is undefined (the
     *  thread path always resolves an explicit value). */
    useCoreMcp?: boolean;
    mcpToolAllowlist?: string[];
    browserCdpEndpoint?: string | null;
    captureTranscripts: boolean;
  };
  benchmark?: {
    evidenceContext: ProductionBenchmarkEvidenceContext | null;
    identityDirective: string;
    rootThreadId: string | null;
    parentThreadId: string | null;
    templateName: string | null;
    agentSlotId: string | null;
    stage: string | null;
    preserveUnreportedAccounting: boolean;
  };
  /**
   * How this run reaches its backend, when that is not simply "the installed CLI, this env".
   * A harness sets it to point the run at a scripted binary or a frozen environment; production
   * leaves it undefined. It lives here rather than under `benchmark` because it is the seam a
   * TEST drives a real run through — the benchmark journal never reads it.
   */
  isolation?: {
    /** Replaces `child_process.spawn` for the backend CLI. */
    spawner?: AgentProcessSpawner;
    /** An explicit CLI binary instead of the discovered one. */
    cliPath?: string;
    /** A frozen environment for the child, instead of inheriting the daemon's. */
    pinnedEnv?: NodeJS.ProcessEnv;
    /** Pre-written MCP config files instead of the generated ones. */
    mcpConfigPaths?: string[];
  };
}

/** A run event consumer. `required` marks sinks whose write/close failure aborts the run. */
export interface RunObserver {
  onEvent(event: RunEvent): void | Promise<void>;
  onClose?(): void | Promise<void>;
  required?: boolean;
}
