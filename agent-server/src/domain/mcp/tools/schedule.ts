import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { normalizeScheduleSpec } from '../../scheduling/schedule-spec.js';
import { addSchedule, pauseSchedule, resumeSchedule } from '../../scheduling/schedule-ops.js';
import { scheduleRepo, channelToProjectId } from '@store/schedule-repo.js';
import { resolveCortexContext, type CortexContextInternal, type CortexToolContext } from './context.js';

// --- Tool implementation: cortex_schedule_add ---

/** The `target` agents still pass out of habit. Every fire opens a new session, so all a target can
 *  still say is which project that session belongs to. */
const targetSchema = z.union([
  z.literal('fresh'),
  z.literal('current-project'),
  z.object({ kind: z.literal('fresh') }),
  z.object({ kind: z.literal('project'), projectId: z.string() }),
]).optional();

/** The project a target names, or null when it leaves the project to projectId/channel. */
export function projectFromTarget(target: z.infer<typeof targetSchema>, ctx: CortexContextInternal): string | null {
  if (target === 'current-project') {
    if (!ctx.project) throw new Error('current-project requested but no project in current context');
    return ctx.project;
  }
  if (typeof target === 'object' && target.kind === 'project') {
    if (!target.projectId) throw new Error('project target requires { projectId }');
    return target.projectId;
  }
  return null;
}

const addInputShape = {
  type: z.enum(['interval', 'daily', 'weekly', 'once']).describe('Schedule type'),
  message: z.string().min(1).describe('Prompt to send when the schedule fires (no [Scheduled Task] prefix — added at fire time)'),
  interval: z.union([z.string(), z.number()]).optional().describe('For type=interval: duration like "30s", "5m", "1h", "1d", or raw ms number'),
  time: z.string().optional().describe('For type=daily/weekly: HH:MM 24-hour'),
  dayOfWeek: z.union([z.string(), z.number()]).optional().describe('For type=weekly: 0-6 (0=Sun) or sun/mon/tue/wed/thu/fri/sat'),
  delay: z.union([z.string(), z.number()]).optional().describe('For type=once: delay from now (duration string or ms)'),
  target: targetSchema.describe('Optional. "current-project" binds the schedule to the project of this session (same as passing projectId). Every fire opens a new session.'),
  profile: z.string().optional().describe('Agent profile name (defaults to active profile)'),
  preCheck: z.string().optional().describe('Optional shell command; non-zero exit → skip this fire. 15s timeout. Receives PRECHECK_LAST_RUN env var.'),
  channel: z.string().optional().describe('Channel used to resolve the project when projectId is omitted. Defaults to the current-context channel.'),
  projectId: z.string().optional().describe('Project id for the schedule. If omitted, resolved from channel via channel-registry.'),
};

async function runScheduleAdd(
  ctx: CortexToolContext, input: z.infer<z.ZodObject<typeof addInputShape>>,
): Promise<unknown> {
  const ctxSnapshot = await resolveCortexContext(ctx);
  // Project: explicit projectId > the project a target names > channel-to-project lookup > 'general'.
  const channel = input.channel ?? ctxSnapshot.channel;
  const projectId = input.projectId
    ?? projectFromTarget(input.target, ctxSnapshot)
    ?? (channel ? channelToProjectId(channel) : null);
  const spec = normalizeScheduleSpec({ ...input, projectId });
  // The running daemon arms the new task when its file watcher sees the write.
  return (await addSchedule(scheduleRepo, spec)).task;
}

// --- Tool registrations ---

export function registerScheduleTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'cortex_schedule_add',
    'Create a scheduled task. Supports interval/daily/weekly/once. Each fire opens a new session in the schedule\'s project and sends it the message, so write a self-contained message. target: "current-project" binds the schedule to this session\'s project.',
    addInputShape,
    async (input) => {
      try {
        const result = await runScheduleAdd(ctx, input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to add schedule: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'cortex_schedule_list',
    'List all scheduled tasks. Returns id, type, message, projectId, profile, timing, nextRun, lastRun, isPaused.',
    { limit: z.number().int().positive().optional().describe('Max records to return (default 50).') },
    { readOnlyHint: true },
    async ({ limit }) => {
      try {
        const data = await scheduleRepo.read();
        const max = limit ?? 50;
        return { content: [{ type: 'text', text: JSON.stringify({ tasks: data.tasks.slice(0, max), totalCount: data.tasks.length }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to list schedules: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'cortex_schedule_get',
    'Look up a scheduled task by id.',
    { id: z.string().describe('Schedule task id (8-char hex from cortex_schedule_add).') },
    { readOnlyHint: true },
    async ({ id }) => {
      try {
        const task = await scheduleRepo.findTask(id);
        if (!task) return { content: [{ type: 'text', text: `No such schedule: ${id}` }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to get schedule: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'cortex_schedule_remove',
    'Delete a scheduled task by id. Idempotent — returns { removed: false } if no such id.',
    { id: z.string().describe('Schedule task id.') },
    async ({ id }) => {
      try {
        const removed = await scheduleRepo.removeTask(id);
        return { content: [{ type: 'text', text: JSON.stringify({ id, removed }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to remove schedule: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'cortex_schedule_pause',
    'Pause a scheduled task (recurring only — once tasks cannot be paused). It stays paused until cortex_schedule_resume.',
    { id: z.string().describe('Schedule task id.') },
    async ({ id }) => {
      try {
        const task = await pauseSchedule(scheduleRepo, id);
        if (!task) return { content: [{ type: 'text', text: `No such schedule: ${id}` }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to pause schedule: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'cortex_schedule_resume',
    'Resume a paused scheduled task. nextRun is recomputed.',
    { id: z.string().describe('Schedule task id.') },
    async ({ id }) => {
      try {
        const task = await resumeSchedule(scheduleRepo, id);
        if (!task) return { content: [{ type: 'text', text: `No such schedule: ${id}` }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to resume schedule: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
