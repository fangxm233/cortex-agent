// input:  UiService, zod operation schemas, and tRPC init
// output: createAppRouter including authentication mutations
// pos:    Typed tRPC mirror of UI operations
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, publicProcedure } from './trpc.js';
import {
  projectsListInput,
  projectsCreateInput,
  sessionsListInput,
  sessionsTranscriptInput,
  sessionsCreateInput,
  sessionsSendInput,
  sessionsCancelInput,
  sessionsCompactInput,
  sessionsSetProfileInput,
  sessionsCreateAndSendInput,
  sessionsMarkReadInput,
  sessionsAnswerQuestionInput,
  sessionsRespondPlanInput,
  sessionsRewindInput,
  sessionsPendingInteractionInput,
  threadsListInput,
  threadsGetInput,
  tasksListInput,
  taskVerificationInput,
  schedulesListInput,
  executionsListInput,
  executionsGetInput,
  memoryTreeInput,
  memoryFileInput,
  approvalsListInput,
  approvalsApproveInput,
  approvalsRejectInput,
  approvalsRequestInput,
  issuesListInput,
  issueActionInput,
  notesListInput,
  noteAddInput,
  noteUpdateInput,
  noteSetCompletedInput,
  noteActionInput,
  notesClearCompletedInput,
  costSummaryInput,
  threadsCancelInput,
  executionsCancelInput,
  scheduleActionInput,
  scheduleAddInput,
  taskActionInput,
  taskCompleteInput,
  taskBlockInput,
  executionsLogInput,
  configGetInput,
  configSetInput,
  authStatusInput,
  authFlowStateInput,
  authStartLoginInput,
  authRespondPromptInput,
  authCancelFlowInput,
  authLogoutInput,
  hooksListInput,
  hooksCreateInput,
  hooksUpdateInput,
  hooksSetEnabledInput,
  hooksRemoveInput,
  hooksTestInput,
  profilesCreateInput,
  profilesUpdateInput,
  profilesRemoveInput,
  machinesListInput,
  skillsListInput,
  threadTemplatesGetInput,
  systemDaemonStatusInput,
  systemRateLimitStatusInput,
  systemRestartInput,
  systemClearRateLimitInput,
} from './input-schemas.js';
import type {
  UiService,
  Result,
  Err,
  QueryScope,
  MutateOp,
  QueryParams,
  MutateArgs,
} from './types.js';

// ── Subscribe filter input (no keyed schema for subscribe; router-local) ──
const subscribeFilterInput = z.object({
  events: z.array(z.string()),
  projectId: z.string().nullish(),
  sessionId: z.string().nullish(),
});

// ── Result → value / Err → TRPCError ─────────────────────────────────────────────
// Domain Err.code strings emitted by ui-service handlers: 'not-found', 'invalid-args',
// 'invalid-name', 'already-terminal', 'already-exists', 'task-lock-busy', 'internal'. Map each to the closest tRPC code;
// preserve the original domain code as `cause` for downstream diagnostics.
const ERR_CODE_MAP: Record<string, TRPCError['code']> = {
  'not-found': 'NOT_FOUND',
  'invalid-args': 'BAD_REQUEST',
  'invalid-name': 'BAD_REQUEST',
  'invalid-notes-file': 'BAD_REQUEST',
  'already-terminal': 'CONFLICT',
  'already-exists': 'CONFLICT',
  'backend-locked': 'CONFLICT',
  'session-running': 'CONFLICT',
  'not-available': 'BAD_REQUEST',
  'not_manageable': 'BAD_REQUEST',
  'external_credential': 'BAD_REQUEST',
  'runtime_unavailable': 'BAD_REQUEST',
  'logout_failed': 'INTERNAL_SERVER_ERROR',
  'task-lock-busy': 'CONFLICT',
  'internal': 'INTERNAL_SERVER_ERROR',
};

function mapErr(err: Err): TRPCError {
  return new TRPCError({
    code: ERR_CODE_MAP[err.code] ?? 'INTERNAL_SERVER_ERROR',
    message: err.message,
    cause: err,
  });
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.data;
  throw mapErr(result as Err);
}

// ── Procedure factories ───────────────────────────────────────────────────────────
// Each factory takes the CONCRETE zod schema (not an index into the keyed map) so tRPC
// infers input from one schema per call — this keeps per-procedure input types precise
// while avoiding a whole-union type instantiation on every procedure (which balloons tsc
// time and the emitted AppRouter .d.ts). The `as unknown as` casts are sound: the
// schemas are parity-guarded (ui-contract/contract.parity.ts) to match QueryParamMap /
// MutateArgsMap, but TS cannot see that equivalence through the generic scope/op.
function makeQuery<S extends QueryScope, Sch extends z.ZodType>(
  uiService: UiService,
  scope: S,
  schema: Sch,
) {
  return publicProcedure
    .input(schema)
    .query(async ({ input }) => unwrap(await uiService.query(scope, input as unknown as QueryParams<S>)));
}

function makeMutation<O extends MutateOp, Sch extends z.ZodType>(
  uiService: UiService,
  op: O,
  schema: Sch,
) {
  return publicProcedure
    .input(schema)
    .mutation(async ({ input }) => unwrap(await uiService.mutate(op, input as unknown as MutateArgs<O>)));
}

// ── AppRouter ─────────────────────────────────────────────────────────────────────

function projectsRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'projects.list', projectsListInput),
    create: makeMutation(service, 'projects.create', projectsCreateInput),
  });
}

function sessionsRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'sessions.list', sessionsListInput),
    transcript: makeQuery(service, 'sessions.transcript', sessionsTranscriptInput),
    pendingInteraction: makeQuery(service, 'sessions.pendingInteraction', sessionsPendingInteractionInput),
    create: makeMutation(service, 'sessions.create', sessionsCreateInput),
    send: makeMutation(service, 'sessions.send', sessionsSendInput),
    cancel: makeMutation(service, 'sessions.cancel', sessionsCancelInput),
    compact: makeMutation(service, 'sessions.compact', sessionsCompactInput),
    setProfile: makeMutation(service, 'sessions.setProfile', sessionsSetProfileInput),
    createAndSend: makeMutation(service, 'sessions.createAndSend', sessionsCreateAndSendInput),
    markRead: makeMutation(service, 'sessions.markRead', sessionsMarkReadInput),
    answerQuestion: makeMutation(service, 'sessions.answerQuestion', sessionsAnswerQuestionInput),
    respondPlan: makeMutation(service, 'sessions.respondPlan', sessionsRespondPlanInput),
    rewind: makeMutation(service, 'sessions.rewind', sessionsRewindInput),
  });
}

function threadsRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'threads.list', threadsListInput),
    get: makeQuery(service, 'threads.get', threadsGetInput),
    cancel: makeMutation(service, 'threads.cancel', threadsCancelInput),
  });
}

function tasksRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'tasks.list', tasksListInput),
    verification: makeQuery(service, 'tasks.verification', taskVerificationInput),
    claim: makeMutation(service, 'tasks.claim', taskActionInput),
    unclaim: makeMutation(service, 'tasks.unclaim', taskActionInput),
    complete: makeMutation(service, 'tasks.complete', taskCompleteInput),
    block: makeMutation(service, 'tasks.block', taskBlockInput),
    unblock: makeMutation(service, 'tasks.unblock', taskActionInput),
  });
}

function schedulesRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'schedules.list', schedulesListInput),
    pause: makeMutation(service, 'schedules.pause', scheduleActionInput),
    resume: makeMutation(service, 'schedules.resume', scheduleActionInput),
    remove: makeMutation(service, 'schedules.remove', scheduleActionInput),
    add: makeMutation(service, 'schedules.add', scheduleAddInput),
  });
}

function executionLogProcedure(service: UiService) {
  return publicProcedure.input(executionsLogInput).subscription(async function* ({ input, signal }) {
    const sub = service.subscribeExecutionLog(input.executionId);
    signal?.addEventListener('abort', () => sub.close());
    try {
      for await (const event of sub) yield event;
    } finally {
      sub.close();
    }
  });
}

function executionsRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'executions.list', executionsListInput),
    get: makeQuery(service, 'executions.get', executionsGetInput),
    cancel: makeMutation(service, 'executions.cancel', executionsCancelInput),
    log: executionLogProcedure(service),
  });
}

function memoryRouter(service: UiService) {
  return router({
    tree: makeQuery(service, 'memory.tree', memoryTreeInput),
    file: makeQuery(service, 'memory.file', memoryFileInput),
  });
}

function approvalsRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'approvals.list', approvalsListInput),
    approve: makeMutation(service, 'approvals.approve', approvalsApproveInput),
    reject: makeMutation(service, 'approvals.reject', approvalsRejectInput),
    request: makeMutation(service, 'approvals.request', approvalsRequestInput),
  });
}

function issuesRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'issues.list', issuesListInput),
    handle: makeMutation(service, 'issues.handle', issueActionInput),
    delete: makeMutation(service, 'issues.delete', issueActionInput),
  });
}

function notesRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'notes.list', notesListInput),
    add: makeMutation(service, 'notes.add', noteAddInput),
    update: makeMutation(service, 'notes.update', noteUpdateInput),
    setCompleted: makeMutation(service, 'notes.setCompleted', noteSetCompletedInput),
    delete: makeMutation(service, 'notes.delete', noteActionInput),
    clearCompleted: makeMutation(service, 'notes.clearCompleted', notesClearCompletedInput),
  });
}

function hooksRouter(service: UiService) {
  return router({
    list: makeQuery(service, 'hooks.list', hooksListInput),
    create: makeMutation(service, 'hooks.create', hooksCreateInput),
    update: makeMutation(service, 'hooks.update', hooksUpdateInput),
    setEnabled: makeMutation(service, 'hooks.setEnabled', hooksSetEnabledInput),
    remove: makeMutation(service, 'hooks.remove', hooksRemoveInput),
    test: makeMutation(service, 'hooks.test', hooksTestInput),
  });
}

// The profiles map of profiles.json. `config.set {section:'profiles'}` keeps owning defaultProfile.
function profilesRouter(service: UiService) {
  return router({
    create: makeMutation(service, 'profiles.create', profilesCreateInput),
    update: makeMutation(service, 'profiles.update', profilesUpdateInput),
    remove: makeMutation(service, 'profiles.remove', profilesRemoveInput),
  });
}

function authRouter(service: UiService) {
  return router({
    status: makeQuery(service, 'auth.status', authStatusInput),
    flowState: makeQuery(service, 'auth.flowState', authFlowStateInput),
    startLogin: makeMutation(service, 'auth.startLogin', authStartLoginInput),
    respondPrompt: makeMutation(service, 'auth.respondPrompt', authRespondPromptInput),
    cancelFlow: makeMutation(service, 'auth.cancelFlow', authCancelFlowInput),
    logout: makeMutation(service, 'auth.logout', authLogoutInput),
  });
}

function systemRouter(service: UiService) {
  return router({
    daemonStatus: makeQuery(service, 'system.daemonStatus', systemDaemonStatusInput),
    rateLimitStatus: makeQuery(service, 'system.rateLimitStatus', systemRateLimitStatusInput),
    restart: makeMutation(service, 'system.restart', systemRestartInput),
    clearRateLimit: makeMutation(service, 'system.clearRateLimit', systemClearRateLimitInput),
  });
}

function subscribeProcedure(service: UiService) {
  return publicProcedure.input(subscribeFilterInput).subscription(async function* ({ input, signal }) {
    const sub = service.subscribe(input);
    signal?.addEventListener('abort', () => sub.close());
    try {
      for await (const event of sub) yield event;
    } finally {
      sub.close();
    }
  });
}

export function createAppRouter(service: UiService) {
  return router({
    projects: projectsRouter(service),
    sessions: sessionsRouter(service),
    threads: threadsRouter(service),
    tasks: tasksRouter(service),
    schedules: schedulesRouter(service),
    executions: executionsRouter(service),
    memory: memoryRouter(service),
    approvals: approvalsRouter(service),
    issues: issuesRouter(service),
    notes: notesRouter(service),
    cost: router({ summary: makeQuery(service, 'cost.summary', costSummaryInput) }),
    config: router({
      get: makeQuery(service, 'config.get', configGetInput),
      set: makeMutation(service, 'config.set', configSetInput),
    }),
    profiles: profilesRouter(service),
    auth: authRouter(service),
    hooks: hooksRouter(service),
    machines: router({ list: makeQuery(service, 'machines.list', machinesListInput) }),
    skills: router({ list: makeQuery(service, 'skills.list', skillsListInput) }),
    threadTemplates: router({ get: makeQuery(service, 'threadTemplates.get', threadTemplatesGetInput) }),
    system: systemRouter(service),
    subscribe: subscribeProcedure(service),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
