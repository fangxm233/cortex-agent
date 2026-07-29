// input:  UiService, zod operation schemas, and tRPC init
// output: createAppRouter with query/mutation/subscription routes
// pos:    Typed tRPC mirror including project notes
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
  hooksListInput,
  hooksCreateInput,
  hooksUpdateInput,
  hooksSetEnabledInput,
  hooksRemoveInput,
  hooksTestInput,
  machinesListInput,
  skillsListInput,
  threadTemplatesGetInput,
  systemDaemonStatusInput,
  systemRateLimitStatusInput,
  systemRestartInput,
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
// Every QueryScope + MutateOp + 2 subscriptions (generic `subscribe` + `executions.log`;
// `subscribeFilterInput` carries `sessionId` for the S4 `session.message` stream),
// mirroring the ui-service contract.
export function createAppRouter(uiService: UiService) {
  return router({
    projects: router({
      list: makeQuery(uiService, 'projects.list', projectsListInput),
      create: makeMutation(uiService, 'projects.create', projectsCreateInput),
    }),
    sessions: router({
      list: makeQuery(uiService, 'sessions.list', sessionsListInput),
      transcript: makeQuery(uiService, 'sessions.transcript', sessionsTranscriptInput),
      pendingInteraction: makeQuery(uiService, 'sessions.pendingInteraction', sessionsPendingInteractionInput),
      create: makeMutation(uiService, 'sessions.create', sessionsCreateInput),
      send: makeMutation(uiService, 'sessions.send', sessionsSendInput),
      cancel: makeMutation(uiService, 'sessions.cancel', sessionsCancelInput),
      compact: makeMutation(uiService, 'sessions.compact', sessionsCompactInput),
      setProfile: makeMutation(uiService, 'sessions.setProfile', sessionsSetProfileInput),
      createAndSend: makeMutation(uiService, 'sessions.createAndSend', sessionsCreateAndSendInput),
      markRead: makeMutation(uiService, 'sessions.markRead', sessionsMarkReadInput),
      answerQuestion: makeMutation(uiService, 'sessions.answerQuestion', sessionsAnswerQuestionInput),
      respondPlan: makeMutation(uiService, 'sessions.respondPlan', sessionsRespondPlanInput),
      rewind: makeMutation(uiService, 'sessions.rewind', sessionsRewindInput),
    }),
    threads: router({
      list: makeQuery(uiService, 'threads.list', threadsListInput),
      get: makeQuery(uiService, 'threads.get', threadsGetInput),
      cancel: makeMutation(uiService, 'threads.cancel', threadsCancelInput),
    }),
    tasks: router({
      list: makeQuery(uiService, 'tasks.list', tasksListInput),
      verification: makeQuery(uiService, 'tasks.verification', taskVerificationInput),
      claim: makeMutation(uiService, 'tasks.claim', taskActionInput),
      unclaim: makeMutation(uiService, 'tasks.unclaim', taskActionInput),
      complete: makeMutation(uiService, 'tasks.complete', taskCompleteInput),
      block: makeMutation(uiService, 'tasks.block', taskBlockInput),
      unblock: makeMutation(uiService, 'tasks.unblock', taskActionInput),
    }),
    schedules: router({
      list: makeQuery(uiService, 'schedules.list', schedulesListInput),
      pause: makeMutation(uiService, 'schedules.pause', scheduleActionInput),
      resume: makeMutation(uiService, 'schedules.resume', scheduleActionInput),
      remove: makeMutation(uiService, 'schedules.remove', scheduleActionInput),
      add: makeMutation(uiService, 'schedules.add', scheduleAddInput),
    }),
    executions: router({
      list: makeQuery(uiService, 'executions.list', executionsListInput),
      get: makeQuery(uiService, 'executions.get', executionsGetInput),
      cancel: makeMutation(uiService, 'executions.cancel', executionsCancelInput),
      // B2-C: live log stream for one running execution. Opening resolves the log location and
      // ref-counts the tailer up; closing/aborting rolls it back down (subscribeExecutionLog).
      log: publicProcedure
        .input(executionsLogInput)
        .subscription(async function* ({ input, signal }) {
          const sub = uiService.subscribeExecutionLog(input.executionId);
          signal?.addEventListener('abort', () => sub.close());
          try {
            for await (const event of sub) {
              yield event;
            }
          } finally {
            sub.close();
          }
        }),
    }),
    memory: router({
      tree: makeQuery(uiService, 'memory.tree', memoryTreeInput),
      file: makeQuery(uiService, 'memory.file', memoryFileInput),
    }),
    approvals: router({
      list: makeQuery(uiService, 'approvals.list', approvalsListInput),
      approve: makeMutation(uiService, 'approvals.approve', approvalsApproveInput),
      reject: makeMutation(uiService, 'approvals.reject', approvalsRejectInput),
      request: makeMutation(uiService, 'approvals.request', approvalsRequestInput),
    }),
    issues: router({
      list: makeQuery(uiService, 'issues.list', issuesListInput),
      handle: makeMutation(uiService, 'issues.handle', issueActionInput),
      delete: makeMutation(uiService, 'issues.delete', issueActionInput),
    }),
    notes: router({
      list: makeQuery(uiService, 'notes.list', notesListInput),
      add: makeMutation(uiService, 'notes.add', noteAddInput),
      update: makeMutation(uiService, 'notes.update', noteUpdateInput),
      setCompleted: makeMutation(uiService, 'notes.setCompleted', noteSetCompletedInput),
      delete: makeMutation(uiService, 'notes.delete', noteActionInput),
      clearCompleted: makeMutation(uiService, 'notes.clearCompleted', notesClearCompletedInput),
    }),
    cost: router({
      summary: makeQuery(uiService, 'cost.summary', costSummaryInput),
    }),
    config: router({
      get: makeQuery(uiService, 'config.get', configGetInput),
      set: makeMutation(uiService, 'config.set', configSetInput),
    }),
    hooks: router({
      list: makeQuery(uiService, 'hooks.list', hooksListInput),
      create: makeMutation(uiService, 'hooks.create', hooksCreateInput),
      update: makeMutation(uiService, 'hooks.update', hooksUpdateInput),
      setEnabled: makeMutation(uiService, 'hooks.setEnabled', hooksSetEnabledInput),
      remove: makeMutation(uiService, 'hooks.remove', hooksRemoveInput),
      test: makeMutation(uiService, 'hooks.test', hooksTestInput),
    }),
    machines: router({
      list: makeQuery(uiService, 'machines.list', machinesListInput),
    }),
    skills: router({
      list: makeQuery(uiService, 'skills.list', skillsListInput),
    }),
    threadTemplates: router({
      get: makeQuery(uiService, 'threadTemplates.get', threadTemplatesGetInput),
    }),
    system: router({
      daemonStatus: makeQuery(uiService, 'system.daemonStatus', systemDaemonStatusInput),
      rateLimitStatus: makeQuery(uiService, 'system.rateLimitStatus', systemRateLimitStatusInput),
      restart: makeMutation(uiService, 'system.restart', systemRestartInput),
    }),
    subscribe: publicProcedure
      .input(subscribeFilterInput)
      .subscription(async function* ({ input, signal }) {
        const sub = uiService.subscribe(input);
        signal?.addEventListener('abort', () => sub.close());
        try {
          for await (const event of sub) {
            yield event;
          }
        } finally {
          sub.close();
        }
      }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
