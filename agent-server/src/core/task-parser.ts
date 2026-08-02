// input:  fs/path/crypto, YAML task files, project paths
// output: Task parsing, serialization, filtering, and generation types
// pos:    Canonical TASKS.yaml schema and query helpers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { PROJECTS_DIR, CONTEXT_DIR } from './paths.js';
import { listProjectDirs } from './utils.js';

// ── Task interface ──

export interface Task {
  id: string;
  text: string;
  why: string;
  done_when: string;
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'done' | 'pending';
  template: string;
  plan: string;
  project: string;
  /** Parent task id (DR-0014 task tree). Children created by decompose --keep-parent point
   *  at the retained parent, which becomes the join/acceptance node via depends_on. */
  parent: string | null;
  depends_on: string[];
  gpu: string | null;
  gpu_count: number;
  blocked_by: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  /** Opaque dispatch incarnation retained through valid automated completion for callback fencing. */
  dispatch_generation: string | null;
  paused: boolean;
  approval_needed: boolean;
  approved_at: string | null;
  not_before: string | null;
  completed_at: string | null;
  completed_note: string | null;
  pending_at: string | null;
  /** Provenance for session→task wake (Problem 1). Captured from CORTEX_* / channel env when a
   *  task is created from within a running session or agent. On task.completed, if origin_channel
   *  is set (and no thread is waiting on this task), the originating session is woken. */
  origin_session_id: string | null;
  origin_channel: string | null;
  origin_thread_id: string | null;
}

// ── Lock state interface ──

export interface TaskGenerationExpectation {
  generation: string | null;
}

export interface LockState {
  owner: string;
  acquired_at: string;
  expires_at: string;
  note?: string;
}

// ── YAML key mapping (kebab-case ↔ snake_case) ──

const YAML_TO_TS: Record<string, string> = {
  'done-when': 'done_when',
  'depends-on': 'depends_on',
  'gpu-count': 'gpu_count',
  'blocked-by': 'blocked_by',
  'claimed-by': 'claimed_by',
  'claimed-at': 'claimed_at',
  'dispatch-generation': 'dispatch_generation',
  'approval-needed': 'approval_needed',
  'approved-at': 'approved_at',
  'not-before': 'not_before',
  'completed-at': 'completed_at',
  'completed-note': 'completed_note',
  'pending-at': 'pending_at',
  'origin-session-id': 'origin_session_id',
  'origin-channel': 'origin_channel',
  'origin-thread-id': 'origin_thread_id',
};

const TS_TO_YAML: Record<string, string> = Object.fromEntries(
  Object.entries(YAML_TO_TS).map(([k, v]) => [v, k]),
);

function yamlKeyToTs(key: string): string {
  return YAML_TO_TS[key] ?? key;
}

function tsKeyToYaml(key: string): string {
  return TS_TO_YAML[key] ?? key;
}

// ── Constants ──

const OVERVIEW_PRIORITY_MAP: Record<string, number> = { '主线': 3, '高': 3, '中': 2, '低': 1 };
const PRIORITY_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };
const VALID_STATUSES = new Set([
  'actionable', 'open', 'blocked', 'in-progress', 'paused',
  'pending', 'completed', 'approval-needed', 'approved',
]);

const TASK_DEFAULTS: Partial<Task> = {
  parent: null,
  depends_on: [],
  gpu: null,
  gpu_count: 1,
  blocked_by: null,
  claimed_by: null,
  claimed_at: null,
  dispatch_generation: null,
  paused: false,
  approval_needed: false,
  approved_at: null,
  not_before: null,
  completed_at: null,
  completed_note: null,
  pending_at: null,
  origin_session_id: null,
  origin_channel: null,
  origin_thread_id: null,
};

// ── Parsing ──

function rawToTask(raw: any, project: string): Task {
  const mapped: any = {};
  for (const [key, value] of Object.entries(raw)) {
    mapped[yamlKeyToTs(key)] = value;
  }
  return {
    id: String(mapped.id ?? ''),
    text: String(mapped.text ?? ''),
    why: String(mapped.why ?? ''),
    done_when: String(mapped.done_when ?? ''),
    priority: PRIORITY_ORDER[mapped.priority] ? mapped.priority : 'medium',
    status: (mapped.status === 'done' || mapped.status === 'pending') ? mapped.status : 'open',
    template: String(mapped.template ?? ''),
    plan: String(mapped.plan ?? ''),
    project,
    parent: mapped.parent != null ? String(mapped.parent) : null,
    depends_on: Array.isArray(mapped.depends_on) ? mapped.depends_on.map(String) : [],
    gpu: mapped.gpu != null ? String(mapped.gpu) : null,
    gpu_count: typeof mapped.gpu_count === 'number' ? mapped.gpu_count : 1,
    blocked_by: mapped.blocked_by != null ? String(mapped.blocked_by) : null,
    claimed_by: mapped.claimed_by != null ? String(mapped.claimed_by) : null,
    claimed_at: mapped.claimed_at != null ? String(mapped.claimed_at) : null,
    dispatch_generation: mapped.dispatch_generation != null ? String(mapped.dispatch_generation) : null,
    paused: Boolean(mapped.paused),
    approval_needed: Boolean(mapped.approval_needed),
    approved_at: mapped.approved_at != null ? String(mapped.approved_at) : null,
    not_before: mapped.not_before != null ? String(mapped.not_before) : null,
    completed_at: mapped.completed_at != null ? String(mapped.completed_at) : null,
    completed_note: mapped.completed_note != null ? String(mapped.completed_note) : null,
    pending_at: mapped.pending_at != null ? String(mapped.pending_at) : null,
    origin_session_id: mapped.origin_session_id != null ? String(mapped.origin_session_id) : null,
    origin_channel: mapped.origin_channel != null ? String(mapped.origin_channel) : null,
    origin_thread_id: mapped.origin_thread_id != null ? String(mapped.origin_thread_id) : null,
  };
}

function parseTasksFile(content: string, project: string): Task[] {
  if (!content.trim()) return [];
  let parsed: any;
  try {
    parsed = yamlParse(content);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.tasks)) return [];
  return parsed.tasks.map((raw: any) => rawToTask(raw, project));
}

function parseTasksFileWithLock(content: string, project: string): { tasks: Task[]; lock: LockState | null } {
  if (!content.trim()) return { tasks: [], lock: null };
  let parsed: any;
  try {
    parsed = yamlParse(content);
  } catch {
    return { tasks: [], lock: null };
  }
  if (!parsed || typeof parsed !== 'object') return { tasks: [], lock: null };
  let lock: LockState | null = null;
  if (parsed.lock && typeof parsed.lock === 'object') {
    const l = parsed.lock;
    if (typeof l.owner === 'string' && typeof l.acquired_at === 'string' && typeof l.expires_at === 'string') {
      lock = {
        owner: l.owner,
        acquired_at: l.acquired_at,
        expires_at: l.expires_at,
        note: typeof l.note === 'string' ? l.note : undefined,
      };
    }
  }
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map((raw: any) => rawToTask(raw, project)) : [];
  return { tasks, lock };
}

// ── Serialization ──

const REQUIRED_KEYS = ['id', 'text', 'why', 'done_when', 'priority', 'status', 'template', 'plan'];
const OPTIONAL_KEY_ORDER = [
  'parent', 'depends_on', 'gpu', 'gpu_count', 'blocked_by', 'claimed_by', 'claimed_at',
  'dispatch_generation', 'paused', 'approval_needed', 'approved_at', 'not_before', 'pending_at',
  'completed_at', 'completed_note',
  'origin_session_id', 'origin_channel', 'origin_thread_id',
];

function isDefault(key: string, value: any): boolean {
  const def = (TASK_DEFAULTS as any)[key];
  if (def === undefined) return false;
  if (Array.isArray(def)) return Array.isArray(value) && value.length === 0;
  return value === def;
}

function taskToYamlObj(task: Task): Record<string, any> {
  const obj: Record<string, any> = {};
  for (const key of REQUIRED_KEYS) {
    obj[tsKeyToYaml(key)] = (task as any)[key];
  }
  for (const key of OPTIONAL_KEY_ORDER) {
    const value = (task as any)[key];
    if (!isDefault(key, value)) {
      obj[tsKeyToYaml(key)] = value;
    }
  }
  return obj;
}

function serializeTasksFile(tasks: Task[]): string {
  if (tasks.length === 0) return 'tasks: []\n';
  const objs = tasks.map(taskToYamlObj);
  return yamlStringify({ tasks: objs }, { lineWidth: 0 });
}

function serializeTasksFileWithLock({ tasks, lock }: { tasks: Task[]; lock?: LockState | null }): string {
  if (tasks.length === 0 && !lock) return 'tasks: []\n';
  const objs = tasks.map(taskToYamlObj);
  if (lock) {
    return yamlStringify({ lock, tasks: objs }, { lineWidth: 0 });
  }
  return yamlStringify({ tasks: objs }, { lineWidth: 0 });
}

// ── Scanning ──

function getTasksYamlPath(project: string): string {
  return path.join(PROJECTS_DIR, project, 'TASKS.yaml');
}

/** Content-keyed parse cache. YAML parsing dominates scan cost (seconds across projects on the
 *  dispatch hot path); the raw read is cheap. Keyed by exact file content, so edits from ANY
 *  process (CLI, git pull, other threads) invalidate naturally — no mtime-granularity races.
 *  Results are structuredClone'd on the way out so callers can never mutate the cached copy. */
const tasksFileCache = new Map<string, { content: string; tasks: Task[] }>();
let tasksCacheHits = 0;
let tasksCacheMisses = 0;

function parseTasksFileCached(tasksPath: string, project: string): Task[] {
  const content = fs.readFileSync(tasksPath, 'utf8');
  const hit = tasksFileCache.get(tasksPath);
  if (hit && hit.content === content) {
    tasksCacheHits++;
    return structuredClone(hit.tasks);
  }
  tasksCacheMisses++;
  const tasks = parseTasksFile(content, project);
  tasksFileCache.set(tasksPath, { content, tasks });
  return structuredClone(tasks);
}

/** Test seam: cumulative cache hit/miss counters for the scanAllTasks content cache. */
function _tasksFileCacheStats(): { hits: number; misses: number } {
  return { hits: tasksCacheHits, misses: tasksCacheMisses };
}

function scanAllTasks(project: string | null = null): Task[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const tasks: Task[] = [];
  for (const projectName of listProjectDirs()) {
    if (project && projectName !== project) continue;
    const tasksPath = getTasksYamlPath(projectName);
    if (!fs.existsSync(tasksPath)) continue;
    tasks.push(...parseTasksFileCached(tasksPath, projectName));
  }
  return tasks;
}

// ── Query helpers ──

function parseProjectPriorities(): Record<string, number> {
  const overviewPath = path.join(CONTEXT_DIR, 'OVERVIEW.md');
  if (!fs.existsSync(overviewPath)) return {};
  const lines = fs.readFileSync(overviewPath, 'utf8').split('\n');
  const priorities: Record<string, number> = {};
  let headerFound = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped.startsWith('|')) { if (headerFound) break; continue; }
    const columns = stripped.split('|').slice(1, -1).map((col) => col.trim());
    if (columns.length < 3) continue;
    if (!headerFound) { headerFound = columns[0].toLowerCase() === 'project'; continue; }
    if (columns[0].startsWith('-')) continue;
    priorities[columns[0]] = OVERVIEW_PRIORITY_MAP[columns[2].replace(/\*\*/g, '')] || 0;
  }
  return priorities;
}

function completedHashSet(tasks: Task[]): Set<string> {
  return new Set(tasks.filter((t) => t.status === 'done' && t.id).map((t) => t.id));
}

function isActionable(task: Task, completedHashes: Set<string> | null = null): boolean {
  const hasUnmetDeps = completedHashes
    ? task.depends_on.some((dep) => !completedHashes.has(dep))
    : task.depends_on.length > 0;
  const today = new Date().toISOString().slice(0, 10);
  return !(
    task.status === 'done'
    || task.status === 'pending'
    || task.paused
    || task.claimed_by
    || task.blocked_by
    || (task.approval_needed && !task.approved_at)
    || hasUnmetDeps
    || (task.not_before && task.not_before > today)
  );
}

function taskSortKey(task: Task, projectPriorities: Record<string, number>) {
  return [
    projectPriorities[task.project] || 0,
    task.done_when ? 1 : 0,
    PRIORITY_ORDER[task.priority] || 0,
  ];
}

function compareSortKey(left: number[], right: number[]) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return right[i] - left[i];
  }
  return 0;
}

function scanAvailableTasks(): Task[] {
  const projectPriorities = parseProjectPriorities();
  const allTasks = scanAllTasks();
  const completed = completedHashSet(allTasks);
  return allTasks
    .filter((task) => isActionable(task, completed))
    .sort((a, b) => compareSortKey(taskSortKey(a, projectPriorities), taskSortKey(b, projectPriorities)));
}

function getTaskStats() {
  return getTaskStatsFromTasks(scanAllTasks());
}

const TASK_STATUS_CHECKS: [string, (t: Task) => unknown][] = [
  ['blocked', (t) => t.blocked_by],
  ['in-progress', (t) => t.claimed_by],
  ['paused', (t) => t.paused],
  ['approval-needed', (t) => t.approval_needed],
  ['approved', (t) => t.approved_at],
];

function taskStatuses(task: Task, completedHashes: Set<string> | null = null): Set<string> {
  const statuses = new Set(task.status === 'done' ? ['completed'] : ['open']);
  if (isActionable(task, completedHashes)) statuses.add('actionable');
  for (const [name, check] of TASK_STATUS_CHECKS) {
    if (check(task)) statuses.add(name);
  }
  return statuses;
}

function taskTags(task: Task): Set<string> {
  const tags = new Set<string>();
  if (task.paused) tags.add('paused');
  if (task.approval_needed) tags.add('approval-needed');
  if (task.gpu) { tags.add('gpu'); tags.add(`gpu:${task.gpu}`); }
  if (task.template) tags.add(`template:${task.template}`);
  return tags;
}

function filterTasks(tasks: Task[], args: any, completedHashes: Set<string> | null = null): Task[] {
  let filtered = tasks;
  if (args.project) filtered = filtered.filter((t) => t.project === args.project);
  if (args.taskId) filtered = filtered.filter((t) => t.id === args.taskId);
  if (args.status) filtered = filtered.filter((t) => taskStatuses(t, completedHashes).has(args.status));
  if (args.priority) filtered = filtered.filter((t) => t.priority === args.priority);
  if (args.text) {
    const needle = args.text.toLowerCase();
    filtered = filtered.filter((t) => t.text.toLowerCase().includes(needle));
  }
  if (args.tag && args.tag.length > 0) filtered = filtered.filter((t) => args.tag.every((tag: string) => taskTags(t).has(tag)));
  if (args.hasDeps) filtered = filtered.filter((t) => t.depends_on.length > 0);
  if (args.noDeps) filtered = filtered.filter((t) => t.depends_on.length === 0);
  return filtered;
}

// ── Stats ──

function computeProjectStats(projectTasks: Task[], completed: Set<string>) {
  return {
    actionable: projectTasks.filter((t) => isActionable(t, completed)).length,
    blocked: projectTasks.filter((t) => t.blocked_by).length,
    in_progress: projectTasks.filter((t) => t.claimed_by).length,
    paused: projectTasks.filter((t) => t.paused).length,
    completed: projectTasks.filter((t) => t.status === 'done').length,
    total: projectTasks.length,
  };
}

function getTaskStatsFromTasks(tasks: Task[]) {
  const completed = completedHashSet(tasks);
  const stats: any = {
    projects: {},
    total: { actionable: 0, blocked: 0, in_progress: 0, paused: 0, completed: 0, total: 0 },
  };
  for (const project of [...new Set(tasks.map((t) => t.project))].sort()) {
    const projectTasks = tasks.filter((t) => t.project === project);
    const projectStats = computeProjectStats(projectTasks, completed);
    stats.projects[project] = projectStats;
    for (const key of Object.keys(stats.total)) stats.total[key] += projectStats[key];
  }
  return stats;
}

// ── Display ──

function taskDisplayTags(task: Task): string[] {
  const tags: string[] = [];
  if (task.claimed_by) tags.push(`in-progress:${task.claimed_at || task.claimed_by}`);
  if (task.paused) tags.push('paused');
  if (task.blocked_by) tags.push(`blocked:${task.blocked_by}`);
  if (task.depends_on.length > 0) tags.push(`depends-on:${task.depends_on.join(',')}`);
  if (task.gpu) tags.push(`gpu:${task.gpu}`);
  if (task.not_before) tags.push(`not-before:${task.not_before}`);
  return tags;
}

function formatTaskVerbose(task: Task, index: number, tags: string[]): string[] {
  const idText = task.id ? ` #${task.id}` : '';
  const tagText = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const lines = [`\n${index + 1}.${idText} [${task.project}] ${task.text}${tagText}`];
  lines.push(`   Priority: ${task.priority}`);
  if (task.done_when) lines.push(`   Done when: ${task.done_when}`);
  if (task.why) lines.push(`   Why: ${task.why}`);
  return lines;
}

function formatTaskCompact(task: Task, tags: string[]): string {
  const status = task.status === 'done' ? '[x]' : '[ ]';
  const idText = task.id ? ` #${task.id}` : '';
  const compactTags = tags.length > 0 ? ` (${tags.join(', ')})` : '';
  return `${status}${idText} [${task.project}] ${task.text} [P:${task.priority}]${compactTags}`;
}

function printTaskListToString(tasks: Task[], actionableHeader = false, showDeps = false): string {
  const out: string[] = [];
  if (actionableHeader) {
    out.push('Actionable Tasks (sorted by priority)');
    out.push('='.repeat(50));
  }
  for (const task of tasks) {
    const tags = taskDisplayTags(task);
    let line: string;
    if (actionableHeader) {
      line = formatTaskVerbose(task, tasks.indexOf(task), tags).join('\n');
    } else {
      line = formatTaskCompact(task, tags);
    }
    if (showDeps && task.depends_on.length > 0) {
      line += ` → [${task.depends_on.join(', ')}]`;
    }
    out.push(line);
  }
  return out.join('\n');
}

function printStatsText(stats: any): string {
  const lines = ['Task Supply Statistics', '='.repeat(40)];
  for (const [project, projectStats] of Object.entries(stats.projects as Record<string, any>)) {
    const s = projectStats as any;
    lines.push(`\n${project}:`);
    lines.push(`  Actionable: ${s.actionable}`);
    lines.push(`  Blocked:    ${s.blocked}`);
    lines.push(`  In-progress:${s.in_progress}`);
    lines.push(`  Paused:     ${s.paused}`);
    lines.push(`  Completed:  ${s.completed}`);
    lines.push(`  Total:      ${s.total}`);
  }
  lines.push(`\nTotal actionable: ${stats.total.actionable}`);
  return lines.join('\n');
}

function showPayload(task: Task, tasks: Task[]) {
  const byId = Object.fromEntries(tasks.filter((t) => t.id).map((t) => [t.id, t]));
  const completed = completedHashSet(tasks);
  const depMap: Record<string, Task[]> = {};
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!depMap[dep]) depMap[dep] = [];
      depMap[dep].push(t);
    }
  }
  const dependents = (depMap[task.id] || []).map((d) => d.id).filter(Boolean);
  const dependsOn = task.depends_on.filter((d) => byId[d]).map((d) => byId[d]);
  return { task, actionable: isActionable(task, completed), dependents, depends_on: dependsOn };
}

function depsPayload(task: Task, tasks: Task[]) {
  const payload = showPayload(task, tasks);
  const depMap: Record<string, Task[]> = {};
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!depMap[dep]) depMap[dep] = [];
      depMap[dep].push(t);
    }
  }
  (payload as any).dependents = depMap[task.id] || [];
  return payload;
}

export {
  PRIORITY_ORDER,
  VALID_STATUSES,
  completedHashSet,
  depsPayload,
  filterTasks,
  getTaskStats,
  getTaskStatsFromTasks,
  getTasksYamlPath,
  isActionable,
  parseTasksFile,
  parseTasksFileWithLock,
  printStatsText,
  printTaskListToString,
  rawToTask,
  scanAllTasks,
  scanAvailableTasks,
  _tasksFileCacheStats,
  serializeTasksFile,
  serializeTasksFileWithLock,
  showPayload,
  taskToYamlObj,
  taskStatuses,
  taskTags,
};
