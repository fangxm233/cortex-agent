// input:  ResolvedProfileConfig, agent-adapter types, core agent/thread types, RunEvent
// output: RunRequest, AgentSpec, RunObserver and the RunResult alias
// pos:    Every resolved input a run needs, with no callbacks — the P1.1 request contract.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { AgentProcessSpawner, McpComposition, UserMessage } from '../../agent-adapter/types.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { ProductionBenchmarkEvidenceContext } from '@core/types/thread-types.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import type { RunEvent } from './events.js';

/** One completed run's outcome. Aliased (not redefined) so the whole stack shares `AgentResult`. */
export type RunResult = AgentResult;

/**
 * What an agent *is*, independent of which profile/route runs it. Declared here for P1.1 because the
 * plan §3.1 type does not exist yet; P3.3 moves it into `spec-loader.ts` when `AgentDefinition`
 * (JSON) and `AgentRole` (MD) are both resolved into this one shape.
 */
export interface AgentSpec {
  /** Full system-prompt override; null preserves the backend default. */
  systemPrompt: string | null;
  /** Role/identity text prepended to the user prompt. */
  directive: string | null;
  /** Template with `{{input}}` / `{{artifactPath}}` vars; null when the caller supplies the prompt. */
  promptTemplate: string | null;
  /** Canonical tool names (see normalize/tool-names.ts); null preserves the backend default surface. */
  tools: string[] | null;
  /** Plugin directories resolved for this agent. */
  pluginDirs: string[];
  mcp: {
    composition: McpComposition;
    /** Canonical per-tool MCP allowlist; null preserves the composition's full surface. */
    allowlist: string[] | null;
  };
  /** Backend-specific options the plan groups out of the neutral spec. */
  backendOptions: {
    claudeAgent?: string;
    outputStyle?: string;
  };
}

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
    /** Legacy thread-surface selector kept until P2.1 canonicalizes MCP gating; only consulted
     *  when `mcpComposition` is undefined (the thread path always resolves an explicit value). */
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
