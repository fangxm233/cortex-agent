// input:  zod + ui-service scope/op unions (./types.js)
// output: zod input schema per QueryScope / MutateOp + keyed maps (queryInputSchemas /
//         mutateInputSchemas). Single source of truth; consumed by the tRPC AppRouter
//         and re-exported (runtime) by @cortex-agent/ui-contract for the browser.
// pos:    leaf schema module for the ui-service contract. Kept HERE (not in ui-contract)
//         so the router can consume it without agent-server importing ui-contract — that
//         import would close a workspace build cycle (ui-contract re-exports agent-server
//         types). Contract stays acyclic: agent-server ← ui-contract ← web.
// >>> If I am updated, update CORTEX.md and the parent folder's CORTEX.md <<<

import { z } from 'zod';
import type { QueryScope, MutateOp } from './types.js';

// ── Query input schemas ───────────────────────────────────────────

export const projectsListInput = z.object({});

export const sessionsListInput = z.object({
  projectId: z.string().optional(),
  resumable: z.boolean().optional(),
  origin: z.enum(['direct', 'thread', 'scheduled']).optional(),
});

export const sessionsTranscriptInput = z.object({
  sessionId: z.string(),
});

export const threadsListInput = z.object({
  projectId: z.string().optional(),
  status: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
});

export const threadsGetInput = z.object({
  threadId: z.string(),
});

export const tasksListInput = z.object({
  projectId: z.string().optional(),
  status: z.enum(['open', 'done']).optional(),
  actionable: z.boolean().optional(),
});

export const taskVerificationInput = z.object({
  projectId: z.string(),
  taskId: z.string(),
});

export const schedulesListInput = z.object({
  projectId: z.string().optional(),
  paused: z.boolean().optional(),
});

export const executionsListInput = z.object({
  status: z.array(z.string()).optional(),
  limit: z.number().optional(),
});

export const executionsGetInput = z.object({
  executionId: z.string(),
});

export const memoryTreeInput = z.object({
  projectId: z.string(),
});

export const memoryFileInput = z.object({
  projectId: z.string(),
  path: z.string(),
});

export const approvalsListInput = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'failed']).optional(),
});

export const costSummaryInput = z.object({
  projectId: z.string().nullish(),
});

export const configGetInput = z.object({});

export const machinesListInput = z.object({});

export const skillsListInput = z.object({});

export const threadTemplatesGetInput = z.object({});

export const systemDaemonStatusInput = z.object({});

// ── Subscription input schemas ────────────────────────────────────
// Subscriptions are not part of the query/mutate keyed maps; their input schemas live here too so
// the AppRouter and the browser (@cortex-agent/ui-contract) share one source of truth (B2-C).

export const executionsLogInput = z.object({
  executionId: z.string(),
});

// ── Mutate input schemas ──────────────────────────────────────────

// Presence/type guard only; deep name validation (traversal / reserved / separators) lives in
// ProjectStore.createProject so the rule has one source of truth.
export const projectsCreateInput = z.object({
  name: z.string(),
});

export const sessionsCreateInput = z.object({
  projectId: z.string().optional(),
});

export const sessionsSendInput = z.object({
  sessionId: z.string(),
  text: z.string(),
  attachments: z.array(z.object({
    name: z.string(),
    path: z.string(),
    size: z.number(),
    mimeType: z.string(),
    type: z.enum(['image', 'video', 'file']),
  })).optional(),
});

export const sessionsCancelInput = z.object({
  sessionId: z.string(),
});

export const sessionsMarkReadInput = z.object({
  sessionId: z.string(),
});

export const sessionsSetProfileInput = z.object({
  sessionId: z.string(),
  profileName: z.string().min(1),
});

export const sessionsCreateAndSendInput = z.object({
  projectId: z.string(),
  profileName: z.string().optional(),
  text: z.string(),
  attachments: z.array(z.object({
    name: z.string(),
    path: z.string(),
    size: z.number(),
    mimeType: z.string(),
    type: z.enum(['image', 'video', 'file']),
  })).optional(),
});

export const threadsCancelInput = z.object({
  threadId: z.string(),
});

export const executionsCancelInput = z.object({
  executionId: z.string(),
});

export const scheduleActionInput = z.object({
  scheduleId: z.string(),
});

// ScheduleTarget mirror — kept structurally identical to `ScheduleTarget` in schedule-repo.ts so
// `z.infer` ≡ ScheduleTarget (the contract-parity guard in @cortex-agent/ui-contract enforces it).
const scheduleTargetInput = z.union([
  z.object({ kind: z.literal('fresh') }),
  z.object({ kind: z.literal('project'), projectId: z.string() }),
  z.object({ kind: z.literal('thread'), threadId: z.string(), channel: z.string() }),
]);

// schedules.add (DR-0018 §2.1 7c). Field-level zod + per-type required-field superRefine so the
// router rejects malformed input before the handler runs. intervalMs/delay are raw ms; dayOfWeek 0..6.
export const scheduleAddInput = z
  .object({
    type: z.enum(['interval', 'daily', 'weekly', 'once']),
    message: z.string().min(1),
    projectId: z.string().optional(),
    profile: z.string().optional(),
    intervalMs: z.number().int().positive().optional(),
    time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    delay: z.number().int().positive().optional(),
    target: scheduleTargetInput.optional(),
    fallback: z.enum(['fresh', 'skip', 'wait']).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'interval' && val.intervalMs === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['intervalMs'], message: 'intervalMs is required for type=interval' });
    }
    if ((val.type === 'daily' || val.type === 'weekly') && val.time === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['time'], message: `time is required for type=${val.type}` });
    }
    if (val.type === 'weekly' && val.dayOfWeek === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dayOfWeek'], message: 'dayOfWeek is required for type=weekly' });
    }
    if (val.type === 'once' && val.delay === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['delay'], message: 'delay is required for type=once' });
    }
  });

export const taskActionInput = z.object({
  projectId: z.string(),
  taskId: z.string(),
});

export const taskCompleteInput = z.object({
  projectId: z.string(),
  taskId: z.string(),
  note: z.string().optional(),
});

export const taskBlockInput = z.object({
  projectId: z.string(),
  taskId: z.string(),
  reason: z.string(),
});

// config.set: a discriminated union of the safely-writable sections. `budget` numbers must be
// finite and > 0 — rejects NaN / Infinity / non-positive / non-number. `profiles` re-points the
// default profile only (a non-empty name; existence in profiles.json is enforced in the handler,
// which has the file to check against). Any section not in this union is rejected structurally.
export const configSetInput = z.discriminatedUnion('section', [
  z.object({
    section: z.literal('budget'),
    value: z.object({
      daily_usd: z.number().finite().positive(),
      monthly_usd: z.number().finite().positive(),
    }),
  }),
  z.object({
    section: z.literal('profiles'),
    value: z.object({
      defaultProfile: z.string().min(1),
    }),
  }),
]);

export const approvalsApproveInput = z.object({
  id: z.string(),
});

export const approvalsRejectInput = z.object({
  id: z.string(),
  feedback: z.string().optional(),
});

// approvals.request (task b983): enqueue a high-privilege operation for approval. `kind` is a
// CLOSED enum; the per-kind required field is enforced by superRefine so the router rejects
// malformed input before the handler runs. The handler constructs the entry's prose — the browser
// supplies only the enum + a machine name (sanitized handler-side), never raw markdown.
export const systemRestartInput = z.object({
  kind: z.enum(['soft', 'hard', 'force']),
});

export const approvalsRequestInput = z
  .object({
    kind: z.enum(['reconnect-platform', 'add-machine']),
    platform: z.enum(['slack', 'feishu']).optional(),
    machineName: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === 'reconnect-platform' && val.platform === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['platform'], message: 'platform is required for kind=reconnect-platform' });
    }
    if (val.kind === 'add-machine' && (val.machineName === undefined || val.machineName.trim() === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['machineName'], message: 'machineName is required for kind=add-machine' });
    }
  });

// ── Keyed maps (one entry per QueryScope / MutateOp) ──────────────

export const queryInputSchemas = {
  'projects.list': projectsListInput,
  'sessions.list': sessionsListInput,
  'sessions.transcript': sessionsTranscriptInput,
  'threads.list': threadsListInput,
  'threads.get': threadsGetInput,
  'tasks.list': tasksListInput,
  'tasks.verification': taskVerificationInput,
  'schedules.list': schedulesListInput,
  'executions.list': executionsListInput,
  'executions.get': executionsGetInput,
  'memory.tree': memoryTreeInput,
  'memory.file': memoryFileInput,
  'approvals.list': approvalsListInput,
  'cost.summary': costSummaryInput,
  'config.get': configGetInput,
  'machines.list': machinesListInput,
  'skills.list': skillsListInput,
  'threadTemplates.get': threadTemplatesGetInput,
  'system.daemonStatus': systemDaemonStatusInput,
} satisfies Record<QueryScope, z.ZodType>;

export const mutateInputSchemas = {
  'projects.create': projectsCreateInput,
  'sessions.create': sessionsCreateInput,
  'sessions.send': sessionsSendInput,
  'sessions.cancel': sessionsCancelInput,
  'sessions.setProfile': sessionsSetProfileInput,
  'sessions.createAndSend': sessionsCreateAndSendInput,
  'sessions.markRead': sessionsMarkReadInput,
  'threads.cancel': threadsCancelInput,
  'executions.cancel': executionsCancelInput,
  'schedules.pause': scheduleActionInput,
  'schedules.resume': scheduleActionInput,
  'schedules.remove': scheduleActionInput,
  'schedules.add': scheduleAddInput,
  'tasks.claim': taskActionInput,
  'tasks.unclaim': taskActionInput,
  'tasks.complete': taskCompleteInput,
  'tasks.block': taskBlockInput,
  'tasks.unblock': taskActionInput,
  'approvals.approve': approvalsApproveInput,
  'approvals.reject': approvalsRejectInput,
  'approvals.request': approvalsRequestInput,
  'config.set': configSetInput,
  'system.restart': systemRestartInput,
} satisfies Record<MutateOp, z.ZodType>;
