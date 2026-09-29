import { type Task, getTaskStatsFromTasks } from '@core/task-parser.js';

export function findCycles(tasks: Task[]) {
  const byId = Object.fromEntries(tasks.filter((t) => t.id).map((t) => [t.id, t]));
  const adjacency = Object.fromEntries(
    tasks.filter((t) => t.id).map((t) => [t.id, t.depends_on.filter((d) => byId[d])]),
  );

  const seen = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function dfs(node: string) {
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      if (index !== -1) cycles.push([...stack.slice(index), node]);
      return;
    }
    if (seen.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency[node] || []) dfs(next);
    stack.pop();
    visiting.delete(node);
    seen.add(node);
  }

  for (const node of Object.keys(adjacency)) dfs(node);

  const deduped: string[][] = [];
  const seenKeys = new Set<string>();
  for (const cycle of cycles) {
    const key = cycle.join('->');
    if (!seenKeys.has(key)) { seenKeys.add(key); deduped.push(cycle); }
  }
  return deduped;
}

function lintSingleTask(task: Task, warnings: any[], errors: any[], duplicateCounts: Record<string, number>, byId: Record<string, Task>, validTemplateNames: Set<string> | null) {
  if (task.id) {
    duplicateCounts[task.id] = (duplicateCounts[task.id] || 0) + 1;
    if (!byId[task.id]) byId[task.id] = task;
  } else if (task.status !== 'done') {
    warnings.push({ code: 'missing-id', project: task.project, text: task.text });
  }
  const id = task.id || null;
  if (!task.why) warnings.push({ code: 'missing-why', project: task.project, task_id: id, text: task.text });
  if (!task.done_when) warnings.push({ code: 'missing-done-when', project: task.project, task_id: id, text: task.text });
  if (task.status !== 'done' && !task.template) warnings.push({ code: 'missing-template', project: task.project, task_id: id, text: task.text });
  if (task.status !== 'done' && !task.plan) warnings.push({ code: 'missing-plan', project: task.project, task_id: id, text: task.text });
  if (task.status !== 'done' && task.template && validTemplateNames && !validTemplateNames.has(task.template)) {
    errors.push({ code: 'unknown-template', project: task.project, task_id: id, text: task.text, template: task.template });
  }
}

function lintDuplicates(duplicateCounts: Record<string, number>, errors: any[]) {
  for (const [taskId, count] of Object.entries(duplicateCounts)) {
    if (count > 1) errors.push({ code: 'duplicate-id', task_id: taskId, count });
  }
}

function lintDependencies(tasks: Task[], byId: Record<string, Task>, errors: any[]) {
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (byId[dep]) continue;
      errors.push({ code: 'missing-dependency', task_id: task.id || null, missing: dep, project: task.project, text: task.text });
    }
  }
  for (const cycle of findCycles(tasks)) {
    errors.push({ code: 'dependency-cycle', cycle });
  }
}

/** DR-0014 task tree: parent must reference an existing task; parent chains must be acyclic. */
function lintParents(tasks: Task[], byId: Record<string, Task>, errors: any[]) {
  for (const task of tasks) {
    if (task.parent && !byId[task.parent]) {
      errors.push({ code: 'missing-parent', task_id: task.id || null, missing: task.parent, project: task.project, text: task.text });
    }
  }
  const inReportedCycle = new Set<string>();
  for (const task of tasks) {
    if (!task.id || !task.parent || inReportedCycle.has(task.id)) continue;
    const chain: string[] = [task.id];
    const seen = new Set<string>(chain);
    let cursor = task.parent;
    while (cursor && byId[cursor]) {
      if (seen.has(cursor)) {
        errors.push({ code: 'parent-cycle', cycle: [...chain, cursor] });
        for (const id of chain) inReportedCycle.add(id);
        break;
      }
      seen.add(cursor);
      chain.push(cursor);
      cursor = byId[cursor].parent ?? '';
    }
  }
}

function lintSupplyHealth(summary: any, info: any[]) {
  for (const [project, raw] of Object.entries(summary.projects as Record<string, any>)) {
    const s = raw as any;
    s.healthy_supply = s.actionable >= 2;
    if (!s.healthy_supply) {
      info.push({ code: 'low-actionable-supply', project, actionable: s.actionable });
    }
  }
}

export interface LintOptions {
  validTemplateNames?: Set<string> | null;
}

export function lintTasks(tasks: Task[], options: LintOptions = {}) {
  const errors: any[] = [];
  const warnings: any[] = [];
  const info: any[] = [];
  const byId: Record<string, Task> = {};
  const duplicateCounts: Record<string, number> = {};
  const validTemplateNames = options.validTemplateNames || null;

  for (const task of tasks) lintSingleTask(task, warnings, errors, duplicateCounts, byId, validTemplateNames);
  lintDuplicates(duplicateCounts, errors);
  lintDependencies(tasks, byId, errors);
  lintParents(tasks, byId, errors);

  const summary = getTaskStatsFromTasks(tasks) as any;
  lintSupplyHealth(summary, info);

  return { ok: errors.length === 0, errors, warnings, info, summary };
}
