// input:  ResolvedProfileConfig, agent-adapter types, core agent types, AgentSpec, RunEvent
// output: RunRequest, RunObserver and the RunResult alias
// pos:    Every resolved input a run needs, with no callbacks — the request contract.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

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
    commissionTools: boolean;
  };
  policy: {
    background: 'none' | 'inline' | 'hold' | 'completion-only';
    recordCost: boolean;
    hooks: boolean;
    streamDeltas?: boolean;
    loadRules: boolean;
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
    pinnedEnv?: NodeJS.ProcessEnv;
    cliPath?: string;
    spawner?: AgentProcessSpawner;
    mcpConfigPaths?: string[];
    preserveUnreportedAccounting: boolean;
  };
}

/** A run event consumer. `required` marks sinks whose write/close failure aborts the run. */
export interface RunObserver {
  onEvent(event: RunEvent): void | Promise<void>;
  onClose?(): void | Promise<void>;
  required?: boolean;
}
