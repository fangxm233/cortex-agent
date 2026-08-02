// input:  thread config, benchmark events, process spawning
// output: thread state, runtime policy, lifecycle types
// pos:    Shared type definitions for the thread system
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import type { AgentProcessSpawner, McpComposition } from '../../agent-adapter/types.js';

// --- Thread Identity ---

export type ThreadId = string;       // "thr_XXXXX"
export type AgentSlotId = string;    // "planner", "reviewer", "coder", "qa", "main"

// --- Thread States ---

export type ThreadStatus =
  | 'running'      // an agent step is in progress
  | 'waiting'      // waiting for user input
  | 'rate_limited' // paused mid-run by an API rate limit; non-terminal, auto-resumes when the window resets
  | 'completed'    // all steps done, terminal
  | 'failed'       // unrecoverable error, terminal
  | 'cancelled'    // user cancelled, terminal
  | 'aborted';     // agent self-aborted via the thread_abort tool, terminal

// --- Stage Definition (optional per-stage prompt for multi-phase agents) ---

/** A named stage of an agent. When an agent declares `stages`, each transition target
 *  may select one stage (syntax `"agent:stage"`). Stages that set `continuesSession: true`
 *  send only an incremental prompt when the persistent session is being resumed — the
 *  directive, protocol preamble and auto `previousOutput` injection are all skipped.
 *  Stage prompts MUST reference `{{artifactPath}}` so the agent can self-recover when
 *  the Claude session is lost and the full-bootstrap fallback kicks in. */
export interface StageDefinition {
  promptTemplate: string;            // stage-specific template with {{input}}, {{artifactPath}}, ... vars
  continuesSession?: boolean;        // default false; true = incremental prompt on resume (skip directive+preamble)
  description?: string;              // human-readable description of this stage
}

// --- Independent Agent Definition (top-level in config file) ---

export interface AgentDefinition {
  name: string;                      // agent ID (key in agents map)
  description?: string;              // human-readable description
  profile: string;                   // profile name from profiles.json, or "__active__"
  persistSession: boolean;           // true: reuse session across iterations; false: fresh each time
  directive?: string;                 // agent role/identity definition, prepended to the prompt
  systemPrompt?: string;             // full system prompt override (--system-prompt flag, replaces default)
  promptTemplate?: string;           // template with {{input}}, {{artifactPath}}, {{previousOutput}} vars (omit when using `stages`)
  claudeAgent?: string;              // Claude Code agent name (--agent flag, loads from .claude/agents/)
  outputStyle?: string;              // Claude Code output style (--settings '{"outputStyle":"<value>"}')
  tools?: string;                    // Claude Code tools list (--tools flag, overrides default tool set)
  pluginDirs?: string[];             // plugin directories (--plugin-dir flags, repeatable)
  mcpComposition?: McpComposition;   // explicit MCP privilege surface for this agent
  /** Optional per-stage prompt map. When set, `promptTemplate` is ignored and the engine
   *  selects one stage per step based on the transition target (`"agent:stage"` syntax). */
  stages?: Record<string, StageDefinition>;
  /** Default stage for transitions that target this agent without an explicit stage
   *  (`"agent"` rather than `"agent:stage"`). Required when `stages` has >1 entry; defaults to
   *  the first declared stage otherwise. */
  entryStage?: string;
}

// --- Template Agent Reference (how templates reference agents) ---

/** Template can reference an agent by name (string) or with per-template overrides (object) */
export type TemplateAgentRef = string | {
  ref: string;                       // agent name
  promptTemplate?: string;           // override agent's default promptTemplate
  directive?: string;                 // override agent's default directive
  systemPrompt?: string;             // override agent's systemPrompt (--system-prompt flag)
  persistSession?: boolean;          // override agent's default persistSession
  claudeAgent?: string;              // override agent's claudeAgent
  outputStyle?: string;              // override agent's outputStyle
  tools?: string;                    // override agent's tools
  pluginDirs?: string[];             // override agent's pluginDirs
};

// --- Resolved Agent Slot Config (merged from definition + template override) ---

export interface AgentSlotConfig {
  slotId: AgentSlotId;
  profile: string;                   // profile name from profiles.json, or "__active__"
  persistSession: boolean;           // true: reuse session across iterations; false: fresh each time
  directive?: string;                 // agent role/identity definition, prepended to the prompt
  systemPrompt?: string;             // full system prompt override (--system-prompt flag)
  promptTemplate?: string;           // template with {{input}}, {{artifactPath}}, {{previousOutput}} vars
  claudeAgent?: string;              // Claude Code agent name (--agent flag)
  outputStyle?: string;              // Claude Code output style (--settings)
  tools?: string;                    // Claude Code tools list (--tools flag)
  pluginDirs?: string[];             // plugin directories (--plugin-dir flags)
  mcpComposition?: McpComposition;   // explicit MCP privilege surface for this agent
  /** Per-stage prompts (merged from AgentDefinition; templates currently don't override per stage). */
  stages?: Record<string, StageDefinition>;
  /** Default stage when a transition target omits the `:stage` suffix. */
  entryStage?: string;
}

export interface TransitionCondition {
  type: 'always' | 'convergence' | 'output_contains' | 'output_not_contains';
  marker?: string;          // for convergence: the marker string to look for in output
  pattern?: string;         // for output_contains/output_not_contains: regex pattern
  maxIterations?: number;   // for convergence: max loop count before forced stop
}

/** Transition endpoint. Accepts either `"agent"` (selects agent's entryStage) or `"agent:stage"`.
 *  Parsed at transition-evaluation time by `parseTarget`. */
export type TransitionEndpoint = string;

export interface TransitionRule {
  from: TransitionEndpoint;
  to: TransitionEndpoint;
  condition: TransitionCondition;
}

// --- Hook configuration (lifecycle hooks for thread execution) ---

/** Hook configuration: execute external script at a specific point in the thread lifecycle;
 *  the script can decide whether to insert a temporary agent.
 *
 *  `command` is the full shell invocation string; callers write the interpreter directly
 *  (e.g. "node ~/.cortex/hooks/xxx.mjs", "bash /path/to/handler.sh", etc.).
 *  Aligns with Claude Code settings.json hooks `{ type: "command", command: "..." }` —
 *  no longer depends on the script's +x bit.
 *
 *  `args` are runtime positional arguments appended via the `sh -c 'cmd "$@"'` spawn mechanism,
 *  passed as `$1..$N`. Dynamic parameters (e.g. task_id, project name) go here instead of
 *  being concatenated into the command string.
 *
 *  spawn cwd = REPO_ROOT; relative paths are resolved from the repo root.
 */
export interface ThreadHookConfig {
  command: string;                   // shell command (e.g. "node ~/.cortex/hooks/xxx.mjs")
  args?: string[];                   // runtime positional arguments (passed as $1..$N to command)
  timeout?: number;                  // execution timeout in ms, default 30000
}

/** Result returned by hook script (stdout JSON)
 *  Two modes:
 *  1. insertAgent: true → create a new temporary agent to execute the prompt
 *  2. targetAgent: "slotId" → send prompt to an existing agent's persistent session (stdin if alive, --resume if dead)
 */
export interface HookResult {
  insertAgent: boolean;              // whether to insert a temporary agent
  targetAgent?: AgentSlotId;         // send prompt to an existing agent's session (mutually exclusive with insertAgent, higher priority)
  prompt?: string;                   // agent prompt (required when insertAgent or targetAgent is set)
  profile?: string;                  // profile used by the inserted agent (default "__active__"; for targetAgent, defaults to the target agent's profile)
  directive?: string;                 // agent role/identity definition, prepended to the prompt
}

/** Context received by lifecycle hook scripts through stdin. */
export interface HookContext extends Record<string, unknown> {
  threadId: string;
  templateName: string;
  phase: 'start' | 'transition' | 'end';
  source: string | null;
  project: string;
  projectId: string;
  taskId: string | null;
  taskProject: string | null;
  currentStepIndex: number;
  steps: AgentStep[];
  activeAgent: string;               // the agent about to execute (the next agent on transition)
  previousAgent: string | null;      // the agent that just completed
  artifactContent: string;           // current artifact file content
  userMessage: string;
  totalCostUsd: number;
  /** Typed control intent used to distinguish intentional non-completion. */
  pendingControlAction: 'abort' | 'split' | 'wait' | null;
}

/** Lifecycle hooks for thread templates */
export interface ThreadHooks {
  onStart?: ThreadHookConfig;        // before thread execution starts (before the first step)
  onTransition?: ThreadHookConfig;   // after each transition, before the next step
  onEnd?: ThreadHookConfig;          // after all steps are complete
}

export interface ThreadTemplate {
  name: string;
  description: string;
  agents: TemplateAgentRef[];        // references to agent definitions (string or { ref, overrides })
  transitions: TransitionRule[];
  entryAgent: AgentSlotId;
  /** Stage to enter on the first step. Defaults to the agent's own `entryStage` (or its
   *  single `promptTemplate` pseudo-stage) when omitted. */
  entryStage?: string;
  maxTotalSteps: number;
  maxTotalCostUsd?: number;
  /** Suppress registry, scoped lifecycle, and backend hooks for isolated templates. */
  disableHooks?: boolean;
  hooks?: ThreadHooks;               // optional: lifecycle hooks (onStart, onTransition, onEnd)
}

// --- Shell template binding (DR-0017 D6 Phase 2 / 2.5) ---

/** A compact template that inherits a named "shell" (a parameterized transition-graph
 *  generator) instead of spelling out the full graph. The loader expands it to a full
 *  `ThreadTemplate` at config-load time via `expandShell`, interpolating the binding's
 *  parameter values into the shell's placeholder graph. Lets the structurally identical
 *  worker-review templates collapse to `{shell, worker, reviewer}` bindings.
 *
 *  Parameter values (e.g. `worker`, `reviewer`) live alongside the reserved keys via the
 *  index signature; which of them name agents is declared by the shell's `agents` list. */
export interface ShellTemplateBinding {
  shell: string;                     // shell name, e.g. "worker-review"
  description?: string;              // human-readable description (preserved onto the expanded template)
  maxTotalSteps?: number;            // override the shell's default step budget
  worker?: string;                   // worker-review param: worker agent name (produce stage = its entryStage)
  reviewer?: string;                 // worker-review param: reviewer agent name
  [param: string]: unknown;          // arbitrary shell parameter values
}

/** A named "shell": a parameterized transition-graph generator defined as pure JSON data
 *  (DR-0017 D6 Phase 2.5 — shells live in config, not code). `params` declares the required
 *  binding keys; the string-valued fields carry `{param}` (→ the param's value, an agent name)
 *  and `{param.entryStage}` (→ that agent's entryStage) placeholders that `expandShell`
 *  interpolates. `agents` lists which params name agents (those values are validated to exist). */
export interface ShellDefinition {
  params: string[];                  // required binding parameter names
  agents: string[];                  // agent slots (placeholder strings like "{worker}") — declare which params are agents
  transitions: TransitionRule[];     // transition graph with placeholder endpoints
  entryAgent: string;                // placeholder string, e.g. "{worker}"
  entryStage?: string;               // placeholder string, e.g. "{worker.entryStage}"
  maxTotalSteps: number;             // default step budget (binding.maxTotalSteps overrides)
  maxTotalCostUsd?: number;
  hooks?: ThreadHooks;               // lifecycle hooks (placeholder strings allowed in args)
}

// --- Config file structure ---

/** The thread config, whether loaded from a single `thread-templates.json` or merged across
 *  the `thread-templates/{agents,templates,shells}/` directory. `shells` is only populated in
 *  the directory form; a single-file config has no shells (shell bindings resolve against an
 *  empty map and are fail-soft skipped). */
export interface ThreadConfigFile {
  agents: Record<string, AgentDefinition>;
  /** A template entry is either a full ThreadTemplate or a ShellTemplateBinding that the
   *  loader expands to a full ThreadTemplate before use. */
  templates: Record<string, ThreadTemplate | ShellTemplateBinding>;
  /** Named shell definitions (directory form only). */
  shells?: Record<string, ShellDefinition>;
}

/** @deprecated Use ThreadConfigFile */
export interface ThreadTemplatesFile {
  templates: Record<string, ThreadTemplate>;
}

// --- Agent Step (execution record within a thread) ---

export interface AgentStep {
  stepIndex: number;
  agentSlotId: AgentSlotId;
  /** Stage name this step ran. Null for single-stage agents (no `stages` map declared). */
  stage: string | null;
  executionId: string | null;
  /** Stable Cortex track id — the conversation-history / UI transcript key for this step
   *  (minted at step start by beginStepSession; decoupled from the backend session id). */
  sessionId: string | null;
  /** Backend session id resolved when the agent run settled — the `--resume` target.
   *  Absent (undefined) on records written before the track/backend decoupling, where
   *  `sessionId` held the backend id. */
  backendSessionId?: string | null;
  sessionName: string | null;
  input: string;
  output: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationS: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

// --- Agent Slot (runtime state for an agent within a thread) ---

export interface AgentSlot {
  slotId: AgentSlotId;
  profile: string;
  /** Stable Cortex track id — the conversation-history / UI transcript key. Minted at step
   *  start (beginStepSession) so a RUNNING step is queryable/streamable; for persistSession
   *  slots it stays stable across steps. Decoupled from the backend resume id. */
  sessionId: string | null;
  /** Backend session id (`--resume` target), set when a step settles. Absent (undefined) on
   *  records written before the track/backend decoupling, where `sessionId` held the backend
   *  id — beginStepSession migrates those in place. */
  backendSessionId?: string | null;
  sessionName: string | null;
  status: 'idle' | 'running' | 'completed';
  lastOutput: string | null;
  persistSession: boolean;
  /** Backend session of a step interrupted mid-flight by a provider error/rate limit, set only
   *  when the attempt streamed real activity. One-shot: the rerun consumes it (beginStepSession)
   *  to resume the interrupted session with a continuation reminder instead of restarting the
   *  step from the original prompt. */
  interruptedBackendSessionId?: string | null;
}

// --- Thread Record (runtime state) ---

export interface ThreadRecord {
  id: ThreadId;
  templateName: string | null;       // null for ad-hoc threads (no template)
  status: ThreadStatus;
  channel: string;
  projectId: string;                 // project for cost attribution & routing; default 'general'
  platformThreadId: string | null;
  userMessage: string;
  userMessageTs: string;

  // File-based workspace
  workspacePath: string;             // e.g. "{REPO_ROOT}/tmp/threads/thr_XXXX"
  artifactPath: string;              // e.g. "{REPO_ROOT}/tmp/threads/thr_XXXX/artifact.md"

  agents: Record<AgentSlotId, AgentSlot>;
  activeAgent: AgentSlotId;
  /** Stage to run in the next step. Null for single-stage agents or pre-stage threads. */
  activeStage: string | null;
  currentStepIndex: number;
  steps: AgentStep[];
  iterationCounts: Record<string, number>;  // "from→to" → count (from/to include `:stage` suffix when applicable)

  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  error: string | null;

  /** Agent-self-reported abort reason (set when status='aborted'); null otherwise. */
  abortReason: string | null;

  // Caller-provided metadata (scheduler/dispatch)
  metadata?: ThreadMetadata | null;
}

/** Structured delegation contract attached to a spawned (child) thread (DR-0014).
 *  Composed into the child's prompt by buildContractPrompt and echoed back to the
 *  parent in the completion notice so the parent can verify the deliverable. */
export interface ThreadContract {
  goal: string;                      // one-line objective (becomes the child's mission-chain entry)
  doneWhen?: string | null;          // verifiable completion criteria
  contextFiles?: string[];           // files the child must read before working
  deliverablePath?: string | null;   // where the child must write its output
  budgetUsd?: number | null;         // subtree budget — spawn guard + per-thread circuit breaker
}

/** Caller-provided metadata stored on ThreadRecord, used by thread-runner for execution registry etc. */
export interface ThreadMetadata {
  scheduleTaskId?: string | null;    // schedule task association
  trigger?: string | null;           // execution trigger: 'scheduled' | 'task-dispatch' | 'user' | 'mcp-thread' | ...
  profileOverride?: string | null;   // override agent's configured profile at runtime
  /** Recursion depth: 0 for top-level (direct-agent-spawned) threads, incremented per nested
   *  thread_start via the MCP thread-op bridge. Surfaced to spawned agents as CORTEX_THREAD_DEPTH
   *  so the depth guard can cap runaway agent→thread→agent recursion. */
  depth?: number;
  /** Identity of the agent that spawned this thread via the MCP thread_start bridge, so an agent
   *  can later enumerate the threads it started (thread_list scope=mine). Null for threads not
   *  spawned by an agent (Slack / scheduler / dispatch). */
  parentSessionId?: string | null;
  parentThreadId?: string | null;
  /** Parent's channel + profile, captured at spawn time so the completion callback can wake the
   *  parent (interactive parent → resume its channel session) or address a notice to it. */
  parentChannel?: string | null;
  parentProfile?: string | null;
  /** Messages buffered while a step was executing, to be included in the next step's prompt. */
  pendingMessages?: string[];        // Phase 6: dispatch message buffering

  // --- Recursive thread tree (DR-0014) ---
  /** Root of the thread tree this thread belongs to. Unset on root threads —
   *  use tree.getRootThreadId() which falls back to the thread's own id. */
  rootThreadId?: string | null;
  /** All children ever spawned by this thread via thread_start (terminal ones included).
   *  Doubles as the width / rework hard-cap counter for checkSpawnGuards. */
  childThreadIds?: string[];
  /** Children this thread is still waiting on. status==='waiting' && waitingOn.length>0
   *  identifies a suspended parent (vs. the legacy waiting-for-user semantics). */
  waitingOn?: string[];
  /** Child TASK ids (4-hex) this manager thread is waiting on (DR-0014 §8). Snapshotted from
   *  TASKS.yaml (tasks with parent === metadata.taskId, open and unblocked) at suspension.
   *  task.completed / task.blocked events drain it; resume requires waitingOn AND
   *  waitingOnTasks both empty. Unlike thread children, task children survive restarts. */
  waitingOnTasks?: string[];
  /** Stall marker for the wait-set deadlock guard: the computeStuckWaitSet key of the last
   *  stall this manager was woken for. A waiting manager whose remaining awaited tasks are ALL
   *  stuck behind blocked dependencies is woken once per distinct stall (wake-on-empty alone
   *  would hang it forever); an identical stall never re-wakes — without this the periodic
   *  sweep would wake it every cycle. Cleared on a normal (empty wait set) resume. */
  stuckWakeKey?: string | null;
  /** Children whose results were already queued into pendingMessages — persistent
   *  idempotency for completion callbacks (survives restarts, unlike the in-memory fired set). */
  deliveredChildResults?: string[];
  /** sha256 of the artifact content at the current step's start (DR-0017 W2 checkpoint gate):
   *  set by createThread (initial state) and refreshed by recordStepResult (post-step state ==
   *  next step's start state; nothing writes the artifact between steps). The webhook `control`
   *  wait action rejects thread_wait while the current artifact still matches this baseline —
   *  a manager must write its checkpoint before suspending. Absent → gate fails open. */
  stepStartArtifactHash?: string | null;
  /** steps.length at the last manager-session rotation (DR-0017 W3). Rotation trigger:
   *  steps.length - rotationBaseStepIndex >= CORTEX_MANAGER_ROTATE_STEPS (default 10).
   *  Absent == 0 (never rotated). */
  rotationBaseStepIndex?: number;
  /** Open questions a subtask asked this manager via ask_manager (DR-0016), for visibility /
   *  debugging. The authoritative pending-question state lives in orchestration/manager-qa's
   *  in-memory store; this is the manager-side mirror, cleared by answer_subtask. */
  pendingQuestions?: Array<{ questionId: string; fromTaskId: string | null; question: string }>;
  /** Delegation contract this thread was spawned with (child side). */
  contract?: ThreadContract | null;
  /** Ancestor goal chain, root-first — injected into the child prompt to prevent drift. */
  missionChain?: string[];
  /** Task association persisted for lifecycle payloads and resumed dispatch work. */
  taskId?: string | null;
  taskProject?: string | null;
  /** Opaque TASKS.yaml dispatch incarnation used to fence completion and terminal callbacks. */
  dispatchGeneration?: string | null;
  /** Task text (TASKS.yaml `text`) at dispatch time, for the thread step status line so a glance
   *  shows what is running. Persisted because status updates outlive the in-memory selected task. */
  taskText?: string | null;
  /** Set when the thread was paused (status==='rate_limited') by an API rate limit, so the
   *  resume path and startup recovery can tell a rate-limit pause apart from a real failure. */
  interruptedByRateLimit?: boolean;
  /** Opaque provider key whose active throttle owns this pause. Used for restart reconciliation. */
  rateLimitProvider?: string | null;
  /** Cumulative synthetic provider-outage resumes attempted by this thread. */
  outageResumeCount?: number;
  /** Destination kind decided at spawn time, so re-entry can rebuild RunThreadOptions. */
  resumeDest?: 'interactive-reply' | 'project-report' | null;
  /** Live status message persisted at suspension so the post-resume settle can refresh it
   *  (otherwise it reads "suspended — waiting on children" forever — 2026-06-11 finding). */
  statusMsgRef?: MessageRef | null;
  /** Out-of-band control signal written by the agent's own thread_abort / thread_split /
   *  thread_wait MCP tool (DR-0015 problem 1). The runner reads this at the step boundary and
   *  CLEARS it after consuming, so a control intent fires exactly once. Replaces the old in-band
   *  artifact string markers ([ABORT]/[SPLIT]/[WAIT_CHILDREN]) — agent prose that merely mentions
   *  those tokens can no longer trigger a control action. Set only via the webhook `control`
   *  action, which rejects a second concurrent control on the same thread. */
  pendingControl?: {
    action: 'abort' | 'split' | 'wait';
    kind?: string | null;            // abort: too-big | mis-scoped | blocked-external
    diagnosis?: string | null;       // abort: required free-text diagnosis (= thread.abortReason)
    subtasks?: any[] | null;         // split: decompose subtask array (decomposeTask shape)
    onTasks?: string[] | null;       // wait: explicit task wait set; any selector disables inference
    onThreads?: string[] | null;     // wait: explicit thread wait set; any selector disables inference
    requestedAtStep?: number;        // step index at which the agent requested control
  } | null;
}

// --- Thread Step Result (returned by thread-manager.stepThread) ---

export interface StepResult {
  done: boolean;
  reason?: 'converged' | 'max_iterations' | 'max_steps' | 'no_transition' | 'cost_limit' | 'error' | 'cancelled' | 'aborted';
  step?: AgentStep;
}

// --- Transition Evaluation Result ---

export interface TransitionResult {
  shouldTransition: boolean;
  nextAgent?: AgentSlotId;
  /** Stage name to run on the next agent. Null for single-stage agents. */
  nextStage?: string | null;
  reason: 'transition' | 'converged' | 'max_iterations' | 'cost_limit' | 'no_matching_transition';
}

// --- Run options shared by thread-runner and thread-hook-runner ---
// Imported here (rather than declared in thread-runner.ts) so thread-hook-runner.ts
// can consume RunThreadOptions without creating a circular import.

import type { PlatformAdapter, MessageRef, Destination } from '@platform/index.js';

export interface BenchmarkThreadEvent {
  step: number;
  agentSlotId: AgentSlotId;
  event: NormalizedEvent;
}

export interface BenchmarkThreadRunOptions {
  /** Absolute grader workspace used by every benchmark step's backend process. */
  workspaceCwd: string;
  /** Frozen trial profile; benchmark templates cannot select a different identity. */
  resolvedProfileName: string;
  expectedBackend: 'claude';
  expectedModel: string;
  disableHooks: true;
  disableControlPlane: true;
  failFastOnRateLimit: true;
  /** Optional containment-aware process boundary forwarded to every step. */
  spawner?: AgentProcessSpawner;
  /** Required trajectory sink invoked synchronously for every normalized event. */
  requiredEventSink?: (input: BenchmarkThreadEvent) => void;
  limits?: {
    maxSteps: number;
    maxCostUsd?: number;
    deadlineMs?: number;
  };
}

export interface RunThreadOptions {
  adapter: PlatformAdapter;
  channel: string;
  /** Destination for the thread's OutputStream. Caller must supply — never inferred. */
  destination: Destination;
  threadAnchorId: string | null;
  statusMsg: MessageRef | null;
  startTime: number;
  onProgress?: ((progress: any) => void) | null;
  onToolUse?: ((name: string, input: any) => void) | null;
  files?: any[];
  /** Called by the facade event loop when a plan_written NormalizedEvent fires (PI backend: during turn, not after). */
  onPlanWritten?: ((event: { path: string; content: string; toolUseId: string }) => void) | null;
  /** Called by the facade event loop when an ask_user_question NormalizedEvent fires (PI backend: during turn). */
  onAskUserQuestion?: ((event: { toolUseId: string; questions: Array<{ question: string; options?: string[]; multi?: boolean }> }) => void) | null;
  /** Invoked before end hooks when agent abort must block the owning dispatch task. */
  onAbort?: ((info: { taskId: string; project: string | null; reason: string | null }) => Promise<void> | void) | null;
  /** Per-call lifecycle hooks injected by the caller (task-dispatcher / scheduled-runner / etc.).
   *  Executed AFTER the template's hook at the same phase (template first, extra second) and share
   *  the same execution semantics (HookContext via stdin, insertAgent / targetAgent result).
   *  Not persisted to ThreadRecord — valid only for this runThread() invocation. */
  extraHooks?: {
    onStart?: ThreadHookConfig;
    onTransition?: ThreadHookConfig;
    onEnd?: ThreadHookConfig;
  };
  /** Presence selects the isolated benchmark runtime; absence preserves daemon behavior. */
  benchmark?: BenchmarkThreadRunOptions;
}
