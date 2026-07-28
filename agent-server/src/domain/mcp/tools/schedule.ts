// input:  McpServer, schedule store, scheduler, execution context
// output: cortex_schedule_* tool registrations
// pos:    Provides scheduled-task CRUD to MCP callers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Scheduler, parseDuration } from '../../scheduling/scheduler.js';
import { scheduleRepo, channelToProjectId, type ScheduleTarget, type ScheduleTask } from '@store/schedule-repo.js';
import { resolveCortexContext } from './context.js';

// --- Target shorthand resolver (extracted for unit tests) ---

/** Snapshot of the Cortex execution context — what cortex_context returns, sliced
 *  down to fields needed by target resolution. Decoupled from the Tool's response
 *  shape so the resolver can be unit-tested without spinning up MCP. */
export interface CortexContextSnapshot {
  channel: string | null;
  sessionId: string | null;
  sessionName: string | null;
  threadId: string | null;
  profile: string | null;
  project: string | null;
  backend: string | null;
  scheduleTaskId: string | null;
  callbackSource: string | null;
}

/** Target spec accepted by cortex_schedule_add: shorthand string OR explicit object.
 *  Shorthand strings are resolved to concrete ScheduleTarget objects at create time
 *  (decision: list/get always shows real IDs). */
export type TargetSpec =
  | undefined
  | 'fresh'
  | 'current-project'
  | 'current-thread'
  | ScheduleTarget;

export function resolveTargetShorthand(spec: TargetSpec, ctx: CortexContextSnapshot): ScheduleTarget {
  if (spec === undefined || spec === 'fresh') return { kind: 'fresh' };

  if (spec === 'current-project') {
    if (!ctx.project) throw new Error('current-project requested but no project in current context');
    return { kind: 'project', projectId: ctx.project };
  }
  if (spec === 'current-thread') {
    if (!ctx.threadId || !ctx.channel) {
      throw new Error('current-thread requested but no threadId or channel in current context');
    }
    return { kind: 'thread', threadId: ctx.threadId, channel: ctx.channel };
  }

  // Object form — light validation per kind so we fail fast at create rather than at fire time.
  if (typeof spec === 'object' && spec !== null && 'kind' in spec) {
    if (spec.kind === 'fresh') return { kind: 'fresh' };
    if (spec.kind === 'project') {
      if (!spec.projectId) throw new Error('project target requires { projectId }');
      return { kind: 'project', projectId: spec.projectId };
    }
    if (spec.kind === 'thread') {
      if (!spec.threadId || !spec.channel) {
        throw new Error('thread target requires { threadId, channel }');
      }
      return { kind: 'thread', threadId: spec.threadId, channel: spec.channel };
    }
  }

  throw new Error(`Unknown target spec: ${JSON.stringify(spec)}`);
}

// --- Day-of-week parsing (shared with schedule-cli) ---

const DAY_MAP: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseDayOfWeek(value: string | number): number {
  if (typeof value === 'number') return value;
  if (/^\d+$/.test(value)) return Number(value);
  const n = DAY_MAP[value.toLowerCase()];
  if (n === undefined) throw new Error(`invalid dayOfWeek: ${value}`);
  return n;
}

function parseIntervalSpec(spec: string | number): number {
  if (typeof spec === 'number') return spec;
  const parsed = parseDuration(spec);
  if (parsed) return parsed;
  if (/^\d+$/.test(spec)) return Number(spec);
  throw new Error(`invalid interval: ${spec}`);
}

function parseDelaySpec(spec: string | number): number {
  return parseIntervalSpec(spec);
}

// --- Scheduler instance (no-op runners, no fs watcher; daemon will hot-reload) ---

function makeWriteOnlyScheduler(): Scheduler {
  // Mirrors schedule-cli's pattern: a throwaway Scheduler used purely for its add() timing
  // math + atomic write through the shared scheduleRepo singleton. The daemon's live
  // Scheduler picks the new task up via fs.watch within ~300ms.
  return new Scheduler(async () => {}, null, {}, { watchFile: false });
}

// --- Tool implementation: cortex_schedule_add ---

const targetSchema = z.union([
  z.literal('fresh'),
  z.literal('current-project'),
  z.literal('current-thread'),
  z.object({ kind: z.literal('fresh') }),
  z.object({ kind: z.literal('project'), projectId: z.string() }),
  z.object({ kind: z.literal('thread'), threadId: z.string(), channel: z.string() }),
]).optional();

const fallbackSchema = z.enum(['fresh', 'skip', 'wait']).optional();

const addInputShape = {
  type: z.enum(['interval', 'daily', 'weekly', 'once']).describe('Schedule type'),
  message: z.string().min(1).describe('Prompt to send when the schedule fires (no [Scheduled Task] prefix — added at fire time)'),
  interval: z.union([z.string(), z.number()]).optional().describe('For type=interval: duration like "30s", "5m", "1h", "1d", or raw ms number'),
  time: z.string().optional().describe('For type=daily/weekly: HH:MM 24-hour'),
  dayOfWeek: z.union([z.string(), z.number()]).optional().describe('For type=weekly: 0-6 (0=Sun) or sun/mon/tue/wed/thu/fri/sat'),
  delay: z.union([z.string(), z.number()]).optional().describe('For type=once: delay from now (duration string or ms)'),
  target: targetSchema.describe('Where to land the fired task. Shorthand: "fresh" (default) | "current-project" | "current-thread", or explicit { kind, ...ids }. __current__ shorthand is resolved to concrete IDs at create time.'),
  fallback: fallbackSchema.describe('What to do if the target thread is gone at fire time. fresh (default): silently fall back. skip: post one-line note, do not run. wait: not yet implemented (treated as fresh).'),
  profile: z.string().optional().describe('Agent profile name (defaults to active profile)'),
  preCheck: z.string().optional().describe('Optional shell command; non-zero exit → skip this fire. 15s timeout. Receives PRECHECK_LAST_RUN env var.'),
  channel: z.string().optional().describe('Override the channel used for fresh-fallback. Defaults to current-context channel.'),
  projectId: z.string().optional().describe('Project id for the schedule. If omitted, resolved from channel via channel-registry.'),
};

async function runScheduleAdd(input: z.infer<z.ZodObject<typeof addInputShape>>): Promise<unknown> {
  const ctxSnapshot = await resolveCortexContext();
  const target = resolveTargetShorthand(input.target as TargetSpec, ctxSnapshot);

  // Resolve channel: explicit > target.channel (when not fresh) > current-context channel.
  let channel: string | null = input.channel ?? null;
  if (!channel && target.kind !== 'fresh') channel = (target as { channel: string }).channel;
  if (!channel) channel = ctxSnapshot.channel;
  if (!channel) throw new Error('No channel resolved for fresh-fallback: pass --channel or run inside a context with a resolved channel.');

  // Resolve projectId: explicit > channel-to-project reverse lookup > 'general'.
  const projectId = input.projectId ?? channelToProjectId(channel) ?? 'general';

  const scheduler = makeWriteOnlyScheduler();
  let task: ScheduleTask;
  try {
    if (input.type === 'interval') {
      if (input.interval === undefined) throw new Error('interval is required for type=interval');
      task = await scheduler.add('interval', {
        intervalMs: parseIntervalSpec(input.interval),
        message: input.message, projectId, profile: input.profile ?? null, preCheck: input.preCheck,
      });
    } else if (input.type === 'daily') {
      if (!input.time) throw new Error('time is required for type=daily');
      task = await scheduler.add('daily', { time: input.time, message: input.message, projectId, profile: input.profile ?? null, preCheck: input.preCheck });
    } else if (input.type === 'weekly') {
      if (input.dayOfWeek === undefined) throw new Error('dayOfWeek is required for type=weekly');
      if (!input.time) throw new Error('time is required for type=weekly');
      task = await scheduler.add('weekly', {
        dayOfWeek: parseDayOfWeek(input.dayOfWeek),
        time: input.time, message: input.message, projectId, profile: input.profile ?? null, preCheck: input.preCheck,
      });
    } else {  // once
      if (input.delay === undefined) throw new Error('delay is required for type=once');
      task = await scheduler.add('once', {
        delay: parseDelaySpec(input.delay),
        message: input.message, projectId, profile: input.profile ?? null, preCheck: input.preCheck,
      });
    }
    // Backfill target + fallback fields after add() so timing math (which doesn't know about them) ran first.
    await scheduleRepo.updateTask(task.id, (t) => {
      t.target = target;
      if (input.fallback) t.fallback = input.fallback;
    });
    const updated = await scheduleRepo.findTask(task.id);
    return updated ?? task;
  } finally {
    scheduler.stop();
  }
}

// --- Tool registrations ---

export function registerScheduleTools(server: McpServer): void {
  server.tool(
    'cortex_schedule_add',
    'Create a scheduled task. Supports interval/daily/weekly/once. target shorthand "current-project" | "current-thread" | "fresh" auto-resolves to concrete IDs against the running agent context — no need to call cortex_context first unless you need an explicit ID.',
    addInputShape,
    async (input) => {
      try {
        const result = await runScheduleAdd(input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to add schedule: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'cortex_schedule_list',
    'List all scheduled tasks. Returns id, type, message, channel, profile, target, nextRun, lastRun, isPaused.',
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
    'Pause a scheduled task (recurring only — once tasks cannot be paused). pausedBy is recorded as "user" so the rate-limit auto-resume path skips it.',
    { id: z.string().describe('Schedule task id.') },
    async ({ id }) => {
      try {
        const scheduler = makeWriteOnlyScheduler();
        try {
          const task = await scheduler.pause(id, 'user');
          if (!task) return { content: [{ type: 'text', text: `No such schedule: ${id}` }], isError: true };
          return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
        } finally {
          scheduler.stop();
        }
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
        const scheduler = makeWriteOnlyScheduler();
        try {
          const task = await scheduler.resume(id);
          if (!task) return { content: [{ type: 'text', text: `No such schedule: ${id}` }], isError: true };
          return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
        } finally {
          scheduler.stop();
        }
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to resume schedule: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
