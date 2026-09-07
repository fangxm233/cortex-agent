// input:  McpServer, session tool context, @core/task-parser (reads TASKS.yaml on disk)
// output: task_status / task_result / task_list read-only tool registrations
// pos:    Agent-facing task monitoring. Delegation is done via the cortex-task CLI (add / spawn);
//         these tools let an agent observe a task it created or depends on without shelling out.
//         Read-only and disk-direct (TASKS.yaml is on the shared filesystem) — no daemon webhook,
//         mirroring tools/context.ts. They replace the removed thread_status / thread_result /
//         thread_list monitoring tools now that a task (not a thread) is the unit of delegation.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  scanAllTasks,
  isActionable,
  completedHashSet,
  filterTasks,
  type Task,
} from '@core/task-parser.js';
import type { CortexToolContext } from './context.js';

/** Default project scope from the session context so an in-task agent need not re-declare it.
 *  null = all projects. */
function defaultProject(ctx: CortexToolContext, project?: string): string | null {
  return project || ctx.taskProject || ctx.project || null;
}

function statusView(task: Task, completed: Set<string>): Record<string, unknown> {
  return {
    id: task.id,
    project: task.project,
    text: task.text,
    status: task.status,
    actionable: isActionable(task, completed),
    priority: task.priority,
    template: task.template,
    parent: task.parent,
    depends_on: task.depends_on,
    claimed_by: task.claimed_by,
    blocked_by: task.blocked_by,
  };
}

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function registerTaskMonitorTools(server: McpServer, ctx: CortexToolContext): void {
  // --- task_status ---

  server.tool(
    'task_status',
    'Query a task\'s current lifecycle state: status (open/pending/done), whether it is actionable, who claimed it, what blocks it, its dependencies and parent. Read-only view of TASKS.yaml. Use to poll a child task you created via `cortex-task spawn` (or any task you depend on).',
    {
      task_id: z.string().describe('Task id (4-char hex).'),
      project: z.string().optional().describe('Project to scope the lookup. Defaults to CORTEX_TASK_PROJECT / CORTEX_PROJECT, else all projects.'),
    },
    { readOnlyHint: true },
    async ({ task_id, project }: { task_id: string; project?: string }) => {
      try {
        const all = scanAllTasks(defaultProject(ctx, project));
        const task = all.find((t) => t.id === task_id);
        if (!task) return { content: [{ type: 'text', text: `task ${task_id} not found` }], isError: true };
        return jsonResult(statusView(task, completedHashSet(all)));
      } catch (e) {
        return { content: [{ type: 'text', text: `task_status error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // --- task_result ---

  server.tool(
    'task_result',
    'Fetch a task\'s outcome: its done/blocked state, success criteria (done_when), completion note, and block reason. If the task is not yet terminal, the result is partial (a note flags this). Read-only. Use after a child task you depend on turns terminal to inspect what it produced.',
    {
      task_id: z.string().describe('Task id (4-char hex).'),
      project: z.string().optional().describe('Project to scope the lookup. Defaults to CORTEX_TASK_PROJECT / CORTEX_PROJECT, else all projects.'),
    },
    { readOnlyHint: true },
    async ({ task_id, project }: { task_id: string; project?: string }) => {
      try {
        const all = scanAllTasks(defaultProject(ctx, project));
        const task = all.find((t) => t.id === task_id);
        if (!task) return { content: [{ type: 'text', text: `task ${task_id} not found` }], isError: true };
        const terminal = task.status === 'done' || !!task.blocked_by;
        return jsonResult({
          id: task.id,
          project: task.project,
          text: task.text,
          status: task.status,
          terminal,
          ...(terminal ? {} : { note: 'task not yet terminal — result is partial' }),
          done_when: task.done_when,
          completed_at: task.completed_at,
          completed_note: task.completed_note,
          blocked_by: task.blocked_by,
        });
      } catch (e) {
        return { content: [{ type: 'text', text: `task_result error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // --- task_list ---

  server.tool(
    'task_list',
    'List tasks, newest-first by file order, optionally filtered by project and status. Each entry is a compact status view. Use to see the children you spawned under a parent, or the actionable queue of a project.',
    {
      project: z.string().optional().describe('Project to scope. Defaults to CORTEX_TASK_PROJECT / CORTEX_PROJECT, else all projects.'),
      status: z.string().optional().describe('Filter by status: actionable / open / blocked / in-progress / paused / pending / completed / approval-needed / approved.'),
      parent: z.string().optional().describe('Only tasks whose parent is this task id (the children you spawned).'),
      limit: z.number().optional().describe('Max tasks to return (default 50).'),
    },
    { readOnlyHint: true },
    async ({ project, status, parent, limit }: { project?: string; status?: string; parent?: string; limit?: number }) => {
      try {
        const proj = defaultProject(ctx, project);
        const all = scanAllTasks(proj);
        const completed = completedHashSet(all);
        let tasks = filterTasks(all, { project: proj, status }, completed);
        if (parent) tasks = tasks.filter((t) => t.parent === parent);
        const out = tasks.slice(0, limit ?? 50).map((t) => statusView(t, completed));
        return jsonResult({ count: out.length, tasks: out });
      } catch (e) {
        return { content: [{ type: 'text', text: `task_list error: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
