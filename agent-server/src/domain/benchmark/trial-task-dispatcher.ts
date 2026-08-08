// input:  broker task source, frozen child-template whitelist, P8 template resolver
// output: P9 AwaitableTaskDispatcher — in-trial select/claim, dispatch prompt, await
// pos:    the trial dispatch path; the daemon dispatcher (tasks/) keeps its own
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { randomUUID } from 'node:crypto';
import { createLogger } from '@core/log.js';
import type { Task } from '../../core/task-parser.js';
import {
  mintActorCapability,
  type ActorCapability, type BenchmarkBrokerCapability, type RoleSlot,
} from './capabilities.js';

const log = createLogger('trial-task-dispatch');

/** Structural stand-in for the frozen `ThreadTemplate` (core/types/thread-types.ts). The frozen
 *  `DispatchSelection.template` carries the real type; importing it here would reach
 *  `@platform/index.js` through thread-types.ts:476 and trip the LIVE §7.3 X2 reachability rule
 *  (type-only edges are not exempt, G5-R2). The frozen type IS assignable to this shape, which is
 *  what the single cast in composite-runtime-ports.ts relies on — nothing is re-declared there. */
export interface TrialThreadTemplate {
  name: string;
  description: string;
  agents: readonly unknown[];
  transitions: readonly unknown[];
  entryAgent: string;
  maxTotalSteps: number;
}

/** The selection the in-trial dispatcher returns, structurally identical to the frozen
 *  `DispatchSelection` except for the template stand-in above. */
export interface TrialDispatchSelection {
  task: Task;
  prompt: string;
  template: TrialThreadTemplate;
  /** The §8 fence: the fresh `randomUUID()` generation minted per claim, retained verbatim from
   *  the shipped mint (dispatcher.ts:399 at ad474fd7; the design cites :420 — same class of
   *  drift as §18 G5-N5). §8.4 R1 rejects any mutation carrying a generation other than the live
   *  one, and §8.5 says a generation is never shown to a model. */
  dispatchGeneration: string;
}

/** Everything the in-trial dispatcher reads. The coordinator (Gate 6) binds these once at
 *  construction (§4.2 N-1) from the frozen policy and the broker — the deps are the P2/P3/P8
 *  ports, not the host modules: no task-lock reach, no gpu-monitor reach, no agents/facade
 *  reach, and no dispatcher.ts reach (all are §7.3 X-targets; the lint proves their absence). */
export interface TrialTaskDispatcherDeps {
  /** Broker task source: actionable trial tasks in dispatch order (P2 `getActionable`). A task
   *  with a live attempt is not actionable, so no host execution-registry dedupe is needed. */
  getActionable(): Task[];
  /** Frozen template resolver: the compiled template for a whitelisted name, else `null`
   *  (P8 `getTemplate` — in-trial it never touches the filesystem, §2.7). */
  getTemplate(name: string): TrialThreadTemplate | null;
  /** Frozen policy: the closed child-template whitelist (§2.4). The trial's "loaded set" —
   *  §8.4 R6's shape, whose shipped basis is the dispatcher dropping unknown templates. */
  childTemplateWhitelist: readonly string[];
  /** Broker claim: binds the freshly minted generation to the task (P3 `claim`). §8.3: only the
   *  dispatcher may mint a generation. The wire closes over the actor capability (G5-W4) — the
   *  capability never appears in an argument. */
  claim(taskId: string, generation: string): { success: boolean; message?: string };
  /** Poll cadence for `awaitNextDispatchable`. */
  pollIntervalMs?: number;
  /** Cancellable wait source. The coordinator wires the deterministic clock's sleep (P17). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** §19.12.2 step 4 — the SOLE dispatch-generation mint. Both ordinary selection and the
 *  requested-target claim call it; no other code path mints a generation, and P3 receives no
 *  random generator. Verbatim in expression and semantics from the shipped mint. */
export function mintTrialDispatchGeneration(): string {
  const dispatchGeneration = randomUUID();
  return dispatchGeneration;
}

/** §19.12.2 step 5 — the five target-attempt fields the Gate-6 target-attempt authority returns
 *  for a requested claim. Exactly these five; no generation, token or ticket field exists here. */
export interface TargetAttemptFields {
  readonly attempt_id: string;
  readonly role: RoleSlot;
  readonly ancestry: readonly string[];
  readonly allowed_actions: readonly BenchmarkBrokerCapability[];
  readonly issued_at_epoch_ms: number;
}

export interface TargetAttemptAuthority {
  current(requester: ActorCapability, targetId: string): TargetAttemptFields;
}

/** §19.12.2 — the EXHAUSTIVE input of the dispatcher-owned claim callback factory: the registry,
 *  the P3 claim method, the frozen capability whitelist and the target-attempt authority. It
 *  receives no random function and no caller-supplied generation. */
export interface DispatcherOwnedClaimTargetInput {
  readonly registry: {
    register(capability: ActorCapability): string;
    invalidateToken(tokenId: string): void;
  };
  /** P3 `claim` — invoked with the fresh TARGET capability, never the requester. */
  readonly claim: (
    capability: ActorCapability, taskId: string,
  ) => { success: boolean; message?: string; code?: number };
  /** §2.4's frozen action set for the arm. */
  readonly capability_whitelist: readonly BenchmarkBrokerCapability[];
  readonly targetAttemptAuthority: TargetAttemptAuthority;
}

/** §19.12.2 steps 3–8 — the second leg of `task.claim`. The broker proves the requester and the
 *  target, then calls this callback: it mints a FRESH generation through the sole P9 mint, mints
 *  and registers ONE target ActorCapability (trial_id = requester.trial_id), invokes
 *  `P3.claim(targetCapability, targetId)`, and — on a refusal — invalidates the target token
 *  before returning the failure, so no task claim is ever reported as success. Gate 6 passes the
 *  resulting callback as `BrokerConstruction.claimTarget`. */
export function createDispatcherOwnedClaimTarget(
  input: DispatcherOwnedClaimTargetInput,
): (requester: ActorCapability, targetId: string) => { success: boolean; message?: string; code?: number } {
  const { registry, claim, capability_whitelist, targetAttemptAuthority } = input;
  return (requester, targetId) => {
    // Step 4 — the fresh generation comes from the sole P9 mint, never from the requester.
    const dispatchGeneration = mintTrialDispatchGeneration();
    // Step 5 — the target-attempt authority supplies the five attempt fields.
    const target = targetAttemptAuthority.current(requester, targetId);
    const capability = mintActorCapability({
      trial_id: requester.trial_id,
      task_id: targetId,
      dispatch_generation: dispatchGeneration,
      attempt_id: target.attempt_id,
      role: target.role,
      ancestry: target.ancestry,
      capability_whitelist,
      allowed_actions: target.allowed_actions,
      issued_at_epoch_ms: target.issued_at_epoch_ms,
    });
    // Step 5 — register the exact returned object through the sole production registry.
    registry.register(capability);
    // Step 6 — P3 sees only the fresh target capability.
    let result: ReturnType<typeof claim>;
    try {
      result = claim(capability, targetId);
    } catch (error) {
      registry.invalidateToken(capability.token_id);
      throw error;
    }
    // Step 8 — a refused claim invalidates the target token before the failure is returned.
    if (!result.success) registry.invalidateToken(capability.token_id);
    return result;
  };
}

/** §7.2 P9. The in-trial dispatcher behind the frozen `AwaitableTaskDispatcher` interface. */
export interface TrialTaskDispatcher {
  selectAndClaim(input: { trial: string }): TrialDispatchSelection | null;
  awaitNextDispatchable(signal: AbortSignal): Promise<TrialDispatchSelection | null>;
  buildDispatchPrompt(task: Task): string;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export function createTrialTaskDispatcher(deps: TrialTaskDispatcherDeps): TrialTaskDispatcher {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  return {
    // The trial id names the coordinator's single trial; the deps are already bound to it at
    // construction, so the argument is interface residue, not a runtime input.
    selectAndClaim: () => selectAndClaimOnce(deps),
    awaitNextDispatchable: (signal) => awaitNextDispatchable(deps, pollIntervalMs, signal),
    buildDispatchPrompt,
  };
}

// --- selection ----------------------------------------------------------------------------------

function selectAndClaimOnce(deps: TrialTaskDispatcherDeps): TrialDispatchSelection | null {
  const eligible = filterTrialDispatchable(
    deps.getActionable(), deps.childTemplateWhitelist, deps.getTemplate,
  );
  const selected = eligible[0] ?? null;
  if (!selected) return null;
  if (!isValidDispatchPrompt(selected.text)) {
    log.warn(`Guard dropped task with null/empty text: [${selected.project}] ${selected.id}`);
    return null;
  }

  // The generation fence, minted per claim through the sole P9 mint.
  const dispatchGeneration = mintTrialDispatchGeneration();
  const claim = deps.claim(selected.id, dispatchGeneration);
  if (!claim.success) {
    log.warn(`Claim refused for [${selected.project}] ${selected.id}: ${claim.message ?? 'unknown'}`);
    return null;
  }

  log.info(`Selected: [${selected.project}] ${selected.text}`);
  return {
    task: selected,
    prompt: buildDispatchPrompt(selected),
    template: deps.getTemplate(selected.template)!,
    dispatchGeneration,
  };
}

/** What the in-trial path does INSTEAD of the three removed host couplings: no locked-project
 *  scan (the trial's lock domain is P4 `TrialTaskLocks`, and eligibility reads only the broker
 *  task source), no GPU occupancy preflight (there is no remote device and no gpu-monitor reach
 *  in a trial — §7.3 X6/X7 prove it; gpu-tagged fields are not consulted), and no template-
 *  profile rate limit (a rate-limited trial fails, it does not park — §7.2 P11). The remaining
 *  eligibility is: template present, template in the frozen whitelist (R6), resolvable by the
 *  frozen resolver. */
function isValidDispatchPrompt(value: unknown): boolean {
  if (!value || typeof value === 'object') return false;
  const text = typeof value === 'string' ? value : String(value);
  if (!text.trim()) return false;
  return text !== 'null' && text !== 'undefined';
}

export function filterTrialDispatchable(
  tasks: readonly Task[],
  whitelist: readonly string[],
  getTemplate: (name: string) => unknown,
): Task[] {
  const whitelistSet = new Set(whitelist);
  const eligible: Task[] = [];
  for (const task of tasks) {
    if (!task.template) continue;
    if (!whitelistSet.has(task.template)) {
      warnOnceNonWhitelisted(task);
      continue;
    }
    if (!getTemplate(task.template)) continue;
    eligible.push(task);
  }
  return eligible;
}

const _nonWhitelistedWarnedKeys = new Set<string>();

function warnOnceNonWhitelisted(task: Task): void {
  const key = `${task.id}::${task.template}`;
  if (_nonWhitelistedWarnedKeys.has(key)) return;
  _nonWhitelistedWarnedKeys.add(key);
  log.warn(
    `Skipping task with non-whitelisted template "${task.template}": `
    + `[${task.project}] ${String(task.text).substring(0, 80)}`,
  );
}

// --- await --------------------------------------------------------------------------------------

/** The scheduler drives the shipped poll-driven entry; a trial has no scheduler, so this loop IS
 *  the wait. No dispatchable task and no live attempt is a deadlock — §9.7 code 41, owned by the
 *  terminal predicate, never by this module (the coordinator evaluates it). */
async function awaitNextDispatchable(
  deps: TrialTaskDispatcherDeps,
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<TrialDispatchSelection | null> {
  while (!signal.aborted) {
    const selection = selectAndClaimOnce(deps);
    if (selection) return selection;
    try {
      await deps.sleep(pollIntervalMs, signal);
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    }
  }
  return null;
}

// --- dispatch prompt assembly (verbatim extraction of tasks/dispatcher.ts) ----------------------

function buildDispatchPrompt(task: Task): string {
  const sections = [
    buildTaskSpecSection(task),
    buildIsolationSection(),
    buildEscalationSection(),
    buildCompletionSection(task),
  ];
  return sections.join('\n\n');
}

function buildTaskSpecSection(task: Task): string {
  const taskSpec = [
    '## Task',
    '',
    `**Project:** ${task.project}`,
    `**Task:** ${task.text}`,
  ];
  if (task.why) taskSpec.push(`**Why:** ${task.why}`);
  if (task.done_when) taskSpec.push(`**Done when:** ${task.done_when}`);
  taskSpec.push(`**Task ID:** ${task.id}`);
  if (task.plan) taskSpec.push(`**Plan (MUST read):** ${task.plan}`);
  return taskSpec.join('\n');
}

function buildIsolationSection(): string {
  return [
    '## Workspace Isolation (concurrent-safe)',
    '',
    'Other threads may work on this same project in parallel. If this task will MODIFY CODE inside a project code directory (a git repository outside ~/.cortex), do NOT edit the shared checkout directly — isolate your work in a git worktree:',
    '',
    '1. First confirm the code directory is a git repository AND git is installed. If it is NOT a git repo, or git is unavailable, SKIP isolation entirely and work normally.',
    '2. Otherwise create a worktree on a unique branch named with your thread id ($CORTEX_THREAD_ID), so parallel threads never collide:',
    '     git -C <code-dir> worktree add <code-dir>-wt-$CORTEX_THREAD_ID -b cortex/$CORTEX_THREAD_ID',
    '   Do ALL edits, tests, and commits INSIDE that worktree.',
    '3. When the work is done, integrate back: pull the latest main branch, merge cortex/$CORTEX_THREAD_ID into it, resolve conflicts, then remove the worktree and delete the branch. If conflicts cannot be resolved automatically, STOP and report it in your completion note — never force-overwrite work from another thread.',
    '',
    'On REMOTE machines, run every git/worktree command through remote_bash on the same device you worked on (per-machine code paths are in project-dirs.json).',
    '',
    'This applies ONLY to project code directories, NOT to ~/.cortex bookkeeping (STATUS.md, experiments/, TASKS.yaml).',
  ].join('\n');
}

function buildEscalationSection(): string {
  return [
    '## If This Task Is Mis-Scoped (thread_abort)',
    '',
    'If during execution you discover this task is far bigger than its description suggests, or its scope is wrong (multiple independent work units crammed together, missing prerequisites, contradictory requirements), do NOT grind through it. Call the `thread_abort` tool:',
    '',
    '    thread_abort(kind="too-big", diagnosis="<one-line diagnosis of what the real structure is>")',
    '',
    'The task will be blocked with your diagnosis and escalated: its manager (or a human) re-plans the decomposition with full context. A precise diagnosis is the most valuable thing you can produce here — it beats a half-done grind every time. (Use kind="too-big" or "mis-scoped" for structural problems, "blocked-external" for a missing external resource.) If instead you can already see the right decomposition, call `thread_split` with the subtasks.',
    '',
    '## If The Planning Intent Is Unclear (ask_manager)',
    '',
    'If during execution you hit confusion, a contradiction, or an ambiguous/under-specified intent — and you cannot settle it by reading the deliverable, code, or task spec yourself — do NOT guess and do NOT abort. Ask the manager who planned this task:',
    '',
    '    ask_manager(question="<a specific, self-contained question about the planning intent>")',
    '',
    'This is lighter than thread_abort: it does not give up the task. The call blocks until the manager (or, at the top of the tree, a human) replies, then returns their answer so you can continue. Use it for genuine planning questions ("did you mean approach A or B?", "two done_when conditions conflict — which wins?"), not for things you can verify yourself.',
  ].join('\n');
}

function buildCompletionSection(task: Task): string {
  return [
    '## When Done',
    '',
    '**CRITICAL: Before marking any task complete, verify ALL done_when conditions are actually satisfied.**',
    '',
    'If launching experiments via cortex-run, ALWAYS pass task info so cortex-run can manage task status:',
    `  cortex-run --name NAME --task-project ${task.project} --task-id ${task.id} -- COMMAND`,
    'cortex-run will auto-mark the task pending on start, then complete on success / block on failure.',
    '',
    'If NOT using cortex-run, verify done_when conditions, then run:',
    `  cortex-task complete --project ${task.project} --task-id ${task.id} --note "your completion note"`,
    '',
    '- Update the project STATUS.md if the work changed project state',
  ].join('\n');
}
