// input:  Zod, settings spec, UI-service operation unions
// output: input schemas/maps including API-key/OAuth flows
// pos:    Runtime validation source for the UI contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { z } from 'zod';
import { SETTINGS_SPEC } from '@core/settings-spec.js';
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
  includeArtifactContent: z.boolean().optional(),
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

export const issuesListInput = z.object({
  projectId: z.string(),
});

export const notesListInput = z.object({
  projectId: z.string(),
});

export const costSummaryInput = z.object({
  projectId: z.string().nullish(),
});

export const configGetInput = z.object({});

export const authStatusInput = z.object({});

export const authFlowStateInput = z.object({
  flowId: z.string().min(1),
});

export const machinesListInput = z.object({});

export const skillsListInput = z.object({});

export const threadTemplatesGetInput = z.object({});

export const systemDaemonStatusInput = z.object({});

export const systemRateLimitStatusInput = z.object({});

// ── Subscription input schemas ────────────────────────────────────
// Subscriptions are not part of the query/mutate keyed maps; their input schemas live here too so
// the AppRouter and the browser (@cortex-agent/ui-contract) share one source of truth (B2-C).

export const executionsLogInput = z.object({
  executionId: z.string(),
});

// ── Mutate input schemas ──────────────────────────────────────────

export const authStartLoginInput = z.object({
  backend: z.enum(['claude', 'pi']),
  provider: z.string().min(1),
  authType: z.enum(['api_key', 'oauth']),
});

export const authRespondPromptInput = z.object({
  flowId: z.string().min(1),
  value: z.string().min(1),
});

export const authCancelFlowInput = z.object({
  flowId: z.string().min(1),
});

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

export const sessionsCompactInput = z.object({
  sessionId: z.string(),
});

export const sessionsMarkReadInput = z.object({
  sessionId: z.string(),
});

export const sessionsSetProfileInput = z.object({
  sessionId: z.string(),
  profileName: z.string().min(1),
});

export const sessionsPendingInteractionInput = z.object({
  sessionId: z.string().min(1),
});

export const sessionsAnswerQuestionInput = z.object({
  requestId: z.string().min(1),
  answers: z.record(z.string(), z.string()),
});

export const sessionsRespondPlanInput = z.object({
  requestId: z.string().min(1),
  approved: z.boolean(),
  feedback: z.string().optional(),
});

export const sessionsRewindInput = z.object({
  sessionId: z.string(),
  turnIndex: z.number().int().min(0),
  text: z.string().min(1),
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

const settingTypeSchemas = {
  boolean: z.boolean(),
  number: z.number().finite(),
  'number|null': z.number().finite().nullable(),
  'string[]': z.array(z.string()),
  'string|null': z.string().nullable(),
} as const;

type SettingsShape = {
  [K in keyof typeof SETTINGS_SPEC]:
    (typeof settingTypeSchemas)[(typeof SETTINGS_SPEC)[K]['type']];
};

const settingsShape = Object.fromEntries(
  Object.entries(SETTINGS_SPEC).map(([key, spec]) => [key, settingTypeSchemas[spec.type]]),
) as unknown as SettingsShape;

function rejectUndefinedSettings(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const [key, setting] of Object.entries(value)) {
    if (setting !== undefined) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: 'setting must not be undefined',
    });
  }
}

const settingsValueInput = z.object(settingsShape).partial().strict()
  .superRefine(rejectUndefinedSettings);

// config.set: a discriminated union of the safely-writable sections. `budget` numbers must be
// finite and positive; `profiles` selects an existing default; `settings` accepts only finite,
// spec-typed partial overrides. Any section or settings key outside this union is rejected.
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
  z.object({
    section: z.literal('settings'),
    value: settingsValueInput,
  }),
]);

// ── hooks.* ───────────────────────────────────────────────────────
// The declarative hook registry. `hooks.list` is unparameterised; the write ops take a FLAT draft
// (one field per form control) that mutate/hooks.ts reassembles into the nested declaration.
// Two fields are absent by construction rather than rejected at runtime: `version` (a forged CalVer
// would make the next hook sync treat a user file as shipped and overwrite it) and `blocking`
// (wired to the two shipped webhook hooks, meaningless on a hand-made entry).

export const hooksListInput = z.object({});

const hookFilterValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const hookDraftShape = {
  event: z.string().min(1),
  matcher: z.string().optional(),
  matcherFilters: z.record(z.string(), hookFilterValue).optional(),
  script: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  timeoutSec: z.number().finite().positive().optional(),
  backends: z.array(z.enum(['claude', 'pi'])).optional(),
  requiresTool: z.string().min(1).optional(),
  result: z.enum(['hook-result', 'stdout-as-prompt', 'none']).optional(),
  enabled: z.boolean().optional(),
};

/** The loader requires exactly one of script/command; reject the other two shapes up front. */
function requireExactlyOneRun(
  val: { script?: string; command?: string },
  ctx: z.RefinementCtx,
): void {
  const hasScript = val.script !== undefined;
  const hasCommand = val.command !== undefined;
  if (hasScript === hasCommand) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['script'],
      message: 'exactly one of script or command is required',
    });
  }
}

export const hooksCreateInput = z
  .object({ id: z.string().min(1), ...hookDraftShape })
  .superRefine(requireExactlyOneRun);

export const hooksUpdateInput = z
  .object({ id: z.string().min(1), ...hookDraftShape })
  .superRefine(requireExactlyOneRun);

export const hooksSetEnabledInput = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});

export const hooksRemoveInput = z.object({
  id: z.string().min(1),
});

export const hooksTestInput = z.object({
  id: z.string().min(1),
  payload: z.string(),
});

export const approvalsApproveInput = z.object({
  id: z.string(),
});

// issues.handle / issues.delete — take the target issue off the project's ISSUES.md list.
export const issueActionInput = z.object({
  projectId: z.string(),
  id: z.string(),
});

const noteTextInput = z.string().trim().min(1).max(1000).refine((text) => !/[\r\n]/.test(text), {
  message: 'Note text must be one line',
});

export const noteAddInput = z.object({
  projectId: z.string(),
  text: noteTextInput,
});

export const noteUpdateInput = noteAddInput.extend({ id: z.string() });

export const noteSetCompletedInput = z.object({
  projectId: z.string(),
  id: z.string(),
  completed: z.boolean(),
});

export const noteActionInput = z.object({
  projectId: z.string(),
  id: z.string(),
});

export const notesClearCompletedInput = z.object({
  projectId: z.string(),
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
  'sessions.pendingInteraction': sessionsPendingInteractionInput,
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
  'issues.list': issuesListInput,
  'notes.list': notesListInput,
  'cost.summary': costSummaryInput,
  'config.get': configGetInput,
  'auth.status': authStatusInput,
  'auth.flowState': authFlowStateInput,
  'hooks.list': hooksListInput,
  'machines.list': machinesListInput,
  'skills.list': skillsListInput,
  'threadTemplates.get': threadTemplatesGetInput,
  'system.daemonStatus': systemDaemonStatusInput,
  'system.rateLimitStatus': systemRateLimitStatusInput,
} satisfies Record<QueryScope, z.ZodType>;

export const mutateInputSchemas = {
  'projects.create': projectsCreateInput,
  'sessions.create': sessionsCreateInput,
  'sessions.send': sessionsSendInput,
  'sessions.cancel': sessionsCancelInput,
  'sessions.compact': sessionsCompactInput,
  'sessions.setProfile': sessionsSetProfileInput,
  'sessions.createAndSend': sessionsCreateAndSendInput,
  'sessions.markRead': sessionsMarkReadInput,
  'sessions.answerQuestion': sessionsAnswerQuestionInput,
  'sessions.respondPlan': sessionsRespondPlanInput,
  'sessions.rewind': sessionsRewindInput,
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
  'issues.handle': issueActionInput,
  'issues.delete': issueActionInput,
  'notes.add': noteAddInput,
  'notes.update': noteUpdateInput,
  'notes.setCompleted': noteSetCompletedInput,
  'notes.delete': noteActionInput,
  'notes.clearCompleted': notesClearCompletedInput,
  'config.set': configSetInput,
  'auth.startLogin': authStartLoginInput,
  'auth.respondPrompt': authRespondPromptInput,
  'auth.cancelFlow': authCancelFlowInput,
  'hooks.create': hooksCreateInput,
  'hooks.update': hooksUpdateInput,
  'hooks.setEnabled': hooksSetEnabledInput,
  'hooks.remove': hooksRemoveInput,
  'hooks.test': hooksTestInput,
  'system.restart': systemRestartInput,
} satisfies Record<MutateOp, z.ZodType>;
