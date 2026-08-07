// input:  task store, execution registry, templates, rate limits
// output: generation-owned claims and globally deduplicated dispatch filters
// pos:    Selects and claims the next dispatchable task
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { randomUUID } from 'node:crypto';
import { createLogger } from '@core/log.js';
import { isProjectLocked } from './system/task-lock.js';

const log = createLogger('task-dispatch');
const gpuLog = createLogger('gpu-preflight');
import { getMachineRegistry, getLocalMachine, type MachineEntry } from './dispatch-utils.js';
import { isDeviceOnline } from '../remote/client-manager.js';  // still needed for online check before queryGpuSnapshot
import { queryGpuSnapshot } from '../monitor/gpu-monitor.js';
import * as executionRegistry from '../executions/registry.js';
import type { ExecutionRecord } from '../executions/registry.js';
import { taskStore } from './store.js';
import { taskMutator } from './mutator.js';
import { listTemplateNames } from '../threads/template-loader.js';
import { resolveTemplateProfiles } from '../threads/index.js';
import { allConfigsRateLimited } from '../agents/facade.js';

// --- Interfaces ---

// MachineEntry type imported from dispatch-utils.ts

interface OccupancyGpuInfo {
  index: number;
  occupied: boolean;
  processes: { pid: string; name: string; memoryMB: number }[];
}

interface GpuOccupancyResult {
  gpus: OccupancyGpuInfo[];
  freeIndices: number[];
  allOccupied: boolean;
  error?: string;
}

interface DispatchMatch {
  source: string;
  taskId: string | null;
  machine: string | null;
}

interface SelectAndClaimResult {
  task: any;
  prompt: string;
  template: string | null;
  dispatchGeneration: string | null;
}

interface FilterDeps {
  findActiveDispatchMatch?: (task: any, scheduleTaskId: string) => DispatchMatch | null;
  checkRealGpuOccupancy?: (machine: string) => Promise<GpuOccupancyResult>;
  isTemplateRateLimited?: (templateName: string, dispatchProfile: string | null) => boolean;
  /** Scheduler-resolved dispatch profile — used only to resolve `__active__` template slots. */
  profileName?: string | null;
}


// --- Null/empty prompt guard (ISS-CS-005 durable fix) ---

function isValidDispatchPrompt(value: unknown): boolean {
  if (!value || typeof value === 'object') return false;
  const s = typeof value === 'string' ? value : String(value);
  if (!s.trim()) return false;
  if (s === 'null' || s === 'undefined') return false;
  return true;
}

// --- Locked-project filter: skip tasks from projects with active locks ---

function filterLockedProjects(tasks: any[]): any[] {
  if (!tasks || tasks.length === 0) return tasks;

  const projectCache = new Map<string, boolean>();
  const lockedProjects = new Map<string, string>();

  const filtered = tasks.filter(task => {
    if (!projectCache.has(task.project)) {
      const result = isProjectLocked(task.project);
      projectCache.set(task.project, result.locked);
      if (result.locked && result.owner) {
        lockedProjects.set(task.project, result.owner);
      }
    }
    return !projectCache.get(task.project);
  });

  if (lockedProjects.size > 0) {
    const skippedCount = tasks.length - filtered.length;
    const details = Array.from(lockedProjects.entries())
      .map(([p, o]) => `${p}:${o}`)
      .join(', ');
    log.info(`Skipping ${skippedCount} task(s) from locked projects: [${details}]`);
  }

  return filtered;
}

// --- GPU conflict detection via gpu-monitor ---

const IDLE_PROCESS_PATTERNS = [/Xorg/i, /gnome-shell/i, /compiz/i];

async function checkRealGpuOccupancy(machine: string): Promise<GpuOccupancyResult> {
  const reg: MachineEntry | undefined = getMachineRegistry()[machine];
  if (!reg) return { gpus: [], freeIndices: [], allOccupied: false, error: `Unknown machine: ${machine}` };
  if (reg.gpuCount === 0) return { gpus: [], freeIndices: [], allOccupied: false };

  // Check device online via client-manager
  if (!isDeviceOnline(machine)) {
    gpuLog.info(`Device ${machine} offline, skipping GPU check`);
    return { gpus: [], freeIndices: [], allOccupied: true, error: `Device ${machine} offline` };
  }

  try {
    const snapshot = await queryGpuSnapshot(machine);

    if (snapshot.gpus.length === 0) {
      gpuLog.info(`nvidia-smi unavailable on ${machine}, allowing dispatch`);
      const gpuCount = reg.gpuCount || 0;
      const freeIndices = Array.from({ length: gpuCount }, (_, i) => i);
      return { gpus: [], freeIndices, allOccupied: false };
    }

    // Derive occupancy from snapshot, filtering out idle system processes
    const gpus: OccupancyGpuInfo[] = snapshot.gpus.map(g => {
      const activeProcs = g.processes
        .filter(p => !IDLE_PROCESS_PATTERNS.some(pat => pat.test(p.name)))
        .map(p => ({ pid: p.pid, name: p.name, memoryMB: p.memoryMB }));
      return { index: g.index, occupied: activeProcs.length > 0, processes: activeProcs };
    });

    const freeIndices = gpus.filter(g => !g.occupied).map(g => g.index);
    const allOccupied = gpus.length > 0 && freeIndices.length === 0;
    gpuLog.info(`${machine}: ${gpus.length} GPU(s), ${freeIndices.length} free [${freeIndices.join(',')}]`);
    return { gpus, freeIndices, allOccupied };
  } catch (err) {
    gpuLog.error(`Failed to check GPU on ${machine}: ${(err as Error).message}`);
    const gpuCount = reg.gpuCount || 0;
    const freeIndices = Array.from({ length: gpuCount }, (_, i) => i);
    return { gpus: [], freeIndices, allOccupied: false, error: (err as Error).message };
  }
}

// --- Task selection ---

function selectTask(tasks: any[] | null): any | null {
  if (!tasks || tasks.length === 0) return null;
  return tasks[0];
}

// --- Duplicate detection (execution registry only, no pending tracker) ---

function findActiveDispatchMatch(task: any, _scheduleTaskId?: string): DispatchMatch | null {
  const executionMatch = executionRegistry.findRunningDispatchMatch({
    taskHash: task.id,
    project: task.project,
    taskText: task.text,
  });
  if (executionMatch) {
    return {
      source: 'execution',
      taskId: executionMatch.dispatch?.taskId || null,
      machine: executionMatch.dispatch?.machine || null,
    };
  }
  return null;
}

// --- Template-profile rate-limit eligibility ---
// A task's thread runs with its TEMPLATE's agent profiles (hardcoded profiles win;
// metadata.profileOverride only applies to __active__ slots — see threads/runner.ts).
// Gating on the scheduler-resolved dispatch profile was wrong in both directions:
// it over-blocked templates whose profiles were fine and under-blocked templates
// whose profiles were limited.

/** True when the task's template cannot run: ANY of its agents' profiles is fully
 *  rate-limited (a known-blocked later agent would fail the thread mid-pipeline and
 *  unclaim the task, discarding earlier agents' work). Empty resolution (unknown
 *  template / no concrete profiles) falls back to checking the dispatch profile. */
function isTemplateRateLimited(
  templateName: string,
  dispatchProfile: string | null,
  check: (profile: string | null) => boolean = allConfigsRateLimited,
): boolean {
  const profiles = resolveTemplateProfiles(templateName, dispatchProfile);
  if (profiles.length === 0) return check(dispatchProfile);
  return profiles.some((p) => check(p));
}

// --- Unknown-template warning dedup (per-process, per-(task_hash, template) pair) ---

const _unknownTemplateWarnedKeys = new Set<string>();

function warnOnceUnknownTemplate(task: any): void {
  const key = `${task.id || task.text}::${task.template}`;
  if (_unknownTemplateWarnedKeys.has(key)) return;
  _unknownTemplateWarnedKeys.add(key);
  log.warn(`Skipping task with unknown template "${task.template}": [${task.project}] ${String(task.text).substring(0, 80)}`);
}

// --- Filter dispatchable tasks ---

async function filterDispatchableTasks(tasks: any[] | null, scheduleTaskId: string, gpuBusyCounts: Map<string, number> = new Map(), deps: FilterDeps = {}): Promise<any[]> {
  if (!tasks || tasks.length === 0) return [];

  const findDuplicate = deps.findActiveDispatchMatch || findActiveDispatchMatch;
  const checkGpu = deps.checkRealGpuOccupancy || checkRealGpuOccupancy;
  const checkTemplateRateLimited = deps.isTemplateRateLimited || isTemplateRateLimited;
  const dispatchProfile = deps.profileName ?? null;
  const gpuStatusCache = new Map<string, GpuOccupancyResult>();
  // Fail-open if templates haven't been loaded yet (size === 0): let downstream
  // createThread surface the error rather than silently dropping every task.
  const validTemplates = new Set(listTemplateNames());
  const eligible: any[] = [];
  let rateLimitedCount = 0;

  for (const task of tasks) {
    if (!task.template) {
      continue;
    }
    if (validTemplates.size > 0 && !validTemplates.has(task.template)) {
      warnOnceUnknownTemplate(task);
      continue;
    }
    // Skip tasks whose template profiles are rate-limited; later tasks with
    // usable templates still flow through (per-task gating, not whole-cycle).
    if (checkTemplateRateLimited(task.template, dispatchProfile)) {
      rateLimitedCount += 1;
      continue;
    }
    // Check remote GPU device is online (local machine is always reachable)
    if (task.gpu && task.gpu !== getLocalMachine() && !isDeviceOnline(task.gpu)) {
      continue;
    }

    if (task.gpu) {
      const targetMachine = task.gpu.toLowerCase();
      const reg = getMachineRegistry()[targetMachine];
      const totalSlots = reg?.gpuCount ?? 0;
      const usedSlots = gpuBusyCounts.get(targetMachine) || 0;
      const neededSlots = task.gpu_count || 1;
      if (usedSlots + neededSlots > totalSlots) continue;
    }

    const duplicateMatch = findDuplicate(task, scheduleTaskId);
    if (duplicateMatch) continue;

    if (task.gpu) {
      const targetMachine = task.gpu.toLowerCase();
      let gpuStatus = gpuStatusCache.get(targetMachine);
      if (!gpuStatus) {
        gpuStatus = await checkGpu(targetMachine);
        gpuStatusCache.set(targetMachine, gpuStatus);
      }
      const neededSlots = task.gpu_count || 1;
      if (gpuStatus.allOccupied || gpuStatus.freeIndices.length < neededSlots) continue;
      const assignedIndices = gpuStatus.freeIndices.slice(0, neededSlots);
      task._assignedGpuIndex = neededSlots === 1 ? assignedIndices[0] : assignedIndices.join(',');
      const remainingFree = gpuStatus.freeIndices.slice(neededSlots);
      gpuStatusCache.set(targetMachine, { ...gpuStatus, freeIndices: remainingFree, allOccupied: remainingFree.length === 0 });
    }

    eligible.push(task);
  }

  if (rateLimitedCount > 0) {
    log.info(`Skipped ${rateLimitedCount} task(s) — template profiles rate-limited`);
  }

  return eligible;
}

function hasRunningExecutionForSchedule(records: Pick<ExecutionRecord, 'status' | 'kind' | 'scheduleTaskId'>[], scheduleTaskId: string): boolean {
  return records.some((record) =>
    record.status === 'running' &&
    record.kind === 'scheduled' &&
    record.scheduleTaskId === scheduleTaskId
  );
}

// --- Dispatch prompt assembly ---

function buildDispatchPrompt(task: any): string {
  const sections: string[] = [];

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
  sections.push(taskSpec.join('\n'));

  const isolation = [
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
  ];
  sections.push(isolation.join('\n'));

  const escalation = [
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
  ];
  sections.push(escalation.join('\n'));

  const completion = [
    '## When Done',
    '',
    '**CRITICAL: Before marking any task complete, verify ALL done_when conditions are actually satisfied.**',
    '',
    `If launching experiments via cortex-run, ALWAYS pass task info so cortex-run can manage task status:`,
    `  cortex-run --name NAME --task-project ${task.project} --task-id ${task.id} -- COMMAND`,
    `cortex-run will auto-mark the task pending on start, then complete on success / block on failure.`,
    '',
    `If NOT using cortex-run, verify done_when conditions, then run:`,
    `  cortex-task complete --project ${task.project} --task-id ${task.id} --note "your completion note"`,
    '',
    '- Update the project STATUS.md if the work changed project state',
  ];
  sections.push(completion.join('\n'));

  return sections.join('\n\n');
}

// --- Main entry point: select and claim a task for local execution ---

async function selectAndClaimTask({ scheduleTaskId = 'builtin', dryRun = false, profileName = null }: { scheduleTaskId?: string; dryRun?: boolean; profileName?: string | null }): Promise<SelectAndClaimResult | null> {
  log.info('Starting task selection cycle');

  // Get actionable tasks + GPU busy machines
  let tasks = taskStore.getActionable();
  tasks = filterLockedProjects(tasks);
  const gpuBusyMachines = taskStore.getGpuBusyMachines();
  log.info(`Found ${tasks.length} actionable task(s)`);

  // Filter to dispatchable tasks (incl. per-template rate-limit eligibility)
  const dispatchableTasks = await filterDispatchableTasks(tasks, scheduleTaskId, gpuBusyMachines, { profileName });
  log.info(`${dispatchableTasks.length} task(s) dispatchable after preflight`);

  // Select task
  const selectedTask = selectTask(dispatchableTasks);
  if (!selectedTask) {
    log.info('No dispatchable tasks available');
    return null;
  }
  log.info(`Selected: [${selectedTask.project}] ${selectedTask.text}`);

  // Guard: reject null/empty/whitespace task text before prompt assembly (ISS-CS-005 mitigation).
  // Logged at warn level for visibility (repeated triggers = someone is putting bad data into TASKS.yaml).
  // The defensive unclaim below clears any stale [in-progress] tag from a prior cycle — the task
  // hasn't been claimed by this dispatch pass yet, but may have been claimed-then-aborted earlier.
  if (!isValidDispatchPrompt(selectedTask.text)) {
    log.warn(`Guard dropped task with null/empty text: [${selectedTask.project}] ${selectedTask.id} (schedule=${scheduleTaskId})`);
    await taskMutator.unclaim(selectedTask.id);
    return null;
  }

  // Dry run: return without claiming
  if (dryRun) {
    return {
      task: selectedTask,
      prompt: buildDispatchPrompt(selectedTask),
      template: selectedTask.template || null,
      dispatchGeneration: null,
    };
  }

  // Claim task under a fresh incarnation fence.
  const dispatchGeneration = randomUUID();
  const claimResult = await taskMutator.claim(
    selectedTask.id, 'task-dispatcher', { generation: dispatchGeneration },
  );
  if (!claimResult.success) {
    log.info(`Claim failed: ${claimResult.message}`);
    return null;
  }

  const prompt = buildDispatchPrompt(selectedTask);

  return {
    task: selectedTask,
    prompt,
    template: selectedTask.template || null,
    dispatchGeneration,
  };
}

export {
  selectAndClaimTask,
  hasRunningExecutionForSchedule,
  isValidDispatchPrompt,
  isTemplateRateLimited,
  // For testing
  selectTask,
  filterLockedProjects,
  filterDispatchableTasks,
  findActiveDispatchMatch,
  checkRealGpuOccupancy,
};
