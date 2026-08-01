// input:  UiServiceDeps and query/mutation handlers
// output: createUiService with authentication flow routing
// pos:    Transport-neutral UI-service dispatcher
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { UiServiceDeps, UiService, QueryScope, MutateOp, Result } from './types.js';
import { handleProjectsList } from './query/projects.js';
import { handleSessionsList, handleSessionsTranscript, handleSessionsPendingInteraction } from './query/sessions.js';
import { handleThreadsList, handleThreadsGet } from './query/threads.js';
import { handleTasksList } from './query/tasks.js';
import { handleTaskVerification } from './query/task-verification.js';
import { handleSchedulesList } from './query/schedules.js';
import { handleExecutionsList, handleExecutionsGet } from './query/executions.js';
import { handleMemoryTree, handleMemoryFile } from './query/memory.js';
import { handleApprovalsList } from './query/approvals.js';
import { handleIssuesList } from './query/issues.js';
import { handleNotesList } from './query/notes.js';
import { handleCostSummary } from './query/cost.js';
import { handleConfigGet } from './query/config.js';
import { handleAuthFlowState, handleAuthStatus } from './query/auth.js';
import { handleHooksList } from './query/hooks.js';
import { handleMachinesList } from './query/machines.js';
import { handleSkillsList } from './query/skills.js';
import { handleThreadTemplatesGet } from './query/thread-templates.js';
import { handleSystemDaemonStatus, handleSystemRateLimitStatus } from './query/system.js';
import { handleConfigSet } from './mutate/config.js';
import {
  handleHooksCreate,
  handleHooksUpdate,
  handleHooksSetEnabled,
  handleHooksRemove,
  handleHooksTest,
} from './mutate/hooks.js';
import { handleCreateProject } from './mutate/projects.js';
import { handleCreateSession, handleSendSession, handleCancelSession, handleCompactSession, handleSetProfile, handleCreateAndSend, handleMarkReadSession, handleAnswerQuestion, handleRespondPlan, handleRewindSession } from './mutate/sessions.js';
import { handleCancelThread } from './mutate/threads.js';
import { handleCancelExecution } from './mutate/executions.js';
import {
  handlePauseSchedule,
  handleResumeSchedule,
  handleRemoveSchedule,
  handleAddSchedule,
} from './mutate/schedules.js';
import {
  handleClaimTask,
  handleUnclaimTask,
  handleCompleteTask,
  handleBlockTask,
  handleUnblockTask,
} from './mutate/tasks.js';
import { handleApproveApproval, handleRejectApproval, handleRequestApproval } from './mutate/approvals.js';
import { handleIssuesDelete, handleIssuesHandle } from './mutate/issues.js';
import {
  handleNotesAdd,
  handleNotesClearCompleted,
  handleNotesDelete,
  handleNotesSetCompleted,
  handleNotesUpdate,
} from './mutate/notes.js';
import { handleSystemRestart } from './mutate/system.js';
import {
  handleAuthCancelFlow,
  handleAuthRespondPrompt,
  handleAuthStartLogin,
} from './mutate/auth.js';
import { createSubscription } from './subscribe.js';
import { resolveExecutionLogLocation } from '@domain/executions/log-tailer.js';

type QueryHandler = (deps: UiServiceDeps, params: any) => Promise<any>;
type MutateHandler = (deps: UiServiceDeps, args: any) => Promise<Result<any>>;

const queryHandlers: Record<string, QueryHandler> = {
  'projects.list': (deps) => handleProjectsList(deps),
  'sessions.list': (deps, params) => handleSessionsList(deps, params),
  'sessions.transcript': (deps, params) => handleSessionsTranscript(deps, params),
  'sessions.pendingInteraction': (deps, params) => handleSessionsPendingInteraction(deps, params),
  'threads.list': (deps, params) => handleThreadsList(deps, params),
  'threads.get': (deps, params) => handleThreadsGet(deps, params),
  'tasks.list': (deps, params) => handleTasksList(deps, params),
  'tasks.verification': (deps, params) => handleTaskVerification(deps, params),
  'schedules.list': (deps, params) => handleSchedulesList(deps, params),
  'executions.list': (deps, params) => handleExecutionsList(deps, params),
  'executions.get': (deps, params) => handleExecutionsGet(deps, params),
  'memory.tree': (deps, params) => handleMemoryTree(deps, params),
  'memory.file': (deps, params) => handleMemoryFile(deps, params),
  'approvals.list': (deps, params) => handleApprovalsList(deps, params),
  'issues.list': (deps, params) => handleIssuesList(deps, params),
  'notes.list': (deps, params) => handleNotesList(deps, params),
  'cost.summary': (deps, params) => handleCostSummary(deps, params),
  'config.get': (deps, params) => handleConfigGet(deps, params),
  'auth.status': (deps, params) => handleAuthStatus(params, deps.getAuthStatus),
  'auth.flowState': (deps, params) => handleAuthFlowState(params, deps.authLogin?.getState),
  'hooks.list': (deps, params) => handleHooksList(deps, params),
  'machines.list': (deps, params) => handleMachinesList(deps, params),
  'skills.list': (deps, params) => handleSkillsList(deps, params),
  'threadTemplates.get': (deps, params) => handleThreadTemplatesGet(deps, params),
  'system.daemonStatus': (_deps, params) => handleSystemDaemonStatus(params),
  'system.rateLimitStatus': (_deps, params) => handleSystemRateLimitStatus(params),
};

const mutateHandlers: Record<string, MutateHandler> = {
  'projects.create': (deps, args) => handleCreateProject(deps, args),
  'sessions.create': (deps, args) => handleCreateSession(deps, args),
  'sessions.send': (deps, args) => handleSendSession(deps, args),
  'sessions.cancel': (deps, args) => handleCancelSession(deps, args),
  'sessions.compact': (deps, args) => handleCompactSession(deps, args),
  'sessions.setProfile': (deps, args) => handleSetProfile(deps, args),
  'sessions.createAndSend': (deps, args) => handleCreateAndSend(deps, args),
  'sessions.markRead': (deps, args) => handleMarkReadSession(deps, args),
  'sessions.answerQuestion': (deps, args) => handleAnswerQuestion(deps, args),
  'sessions.respondPlan': (deps, args) => handleRespondPlan(deps, args),
  'sessions.rewind': (deps, args) => handleRewindSession(deps, args),
  'threads.cancel': (deps, args) => handleCancelThread(deps, args),
  'executions.cancel': (deps, args) => handleCancelExecution(deps, args),
  'schedules.pause': (deps, args) => handlePauseSchedule(deps, args),
  'schedules.resume': (deps, args) => handleResumeSchedule(deps, args),
  'schedules.remove': (deps, args) => handleRemoveSchedule(deps, args),
  'schedules.add': (deps, args) => handleAddSchedule(deps, args),
  'tasks.claim': (deps, args) => handleClaimTask(deps, args),
  'tasks.unclaim': (deps, args) => handleUnclaimTask(deps, args),
  'tasks.complete': (deps, args) => handleCompleteTask(deps, args),
  'tasks.block': (deps, args) => handleBlockTask(deps, args),
  'tasks.unblock': (deps, args) => handleUnblockTask(deps, args),
  'approvals.approve': (deps, args) => handleApproveApproval(deps, args),
  'approvals.reject': (deps, args) => handleRejectApproval(deps, args),
  'approvals.request': (deps, args) => handleRequestApproval(deps, args),
  'issues.handle': (deps, args) => handleIssuesHandle(deps, args),
  'issues.delete': (deps, args) => handleIssuesDelete(deps, args),
  'notes.add': (deps, args) => handleNotesAdd(deps, args),
  'notes.update': (deps, args) => handleNotesUpdate(deps, args),
  'notes.setCompleted': (deps, args) => handleNotesSetCompleted(deps, args),
  'notes.delete': (deps, args) => handleNotesDelete(deps, args),
  'notes.clearCompleted': (deps, args) => handleNotesClearCompleted(deps, args),
  'config.set': (deps, args) => handleConfigSet(deps, args),
  'auth.startLogin': (deps, args) => handleAuthStartLogin(deps, args),
  'auth.respondPrompt': (deps, args) => handleAuthRespondPrompt(deps, args),
  'auth.cancelFlow': (deps, args) => handleAuthCancelFlow(deps, args),
  'hooks.create': (deps, args) => handleHooksCreate(deps, args),
  'hooks.update': (deps, args) => handleHooksUpdate(deps, args),
  'hooks.setEnabled': (deps, args) => handleHooksSetEnabled(deps, args),
  'hooks.remove': (deps, args) => handleHooksRemove(deps, args),
  'hooks.test': (deps, args) => handleHooksTest(deps, args),
  'system.restart': (_deps, args) => handleSystemRestart(args),
};

export function redactMutationAuditArgs(op: MutateOp, args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  if (op === 'auth.respondPrompt') {
    const { flowId } = args as { flowId?: unknown };
    return { flowId };
  }
  if (!op.startsWith('notes.')) return args;
  const { text: _privateText, ...safe } = args as Record<string, unknown>;
  return safe;
}

export function createUiService(deps: UiServiceDeps): UiService {
  return {
    async query(scope, params) {
      const handler = queryHandlers[scope];
      if (!handler) {
        return { ok: false, code: 'invalid-args', message: `Unknown query scope: ${scope}` };
      }
      try {
        const data = await handler(deps, params);
        return { ok: true, data };
      } catch (err: any) {
        const code = typeof err?.code === 'string' ? err.code : 'internal';
        return { ok: false, code, message: err?.message || String(err) };
      }
    },

    async mutate(op, args) {
      const handler = mutateHandlers[op];
      if (!handler) {
        return { ok: false, code: 'invalid-args', message: `Unknown mutate op: ${op}` };
      }
      try {
        const result = await handler(deps, args);
        // Publish audit event before returning
        deps.bus.publish({
          type: 'ui.mutate-invoked',
          op,
          args: redactMutationAuditArgs(op, args),
          result: result.ok ? { ok: true } : { ok: false, code: (result as any).code },
        });
        return result;
      } catch (err: any) {
        const errResult: Result<any> = { ok: false, code: 'internal', message: err?.message || String(err) };
        deps.bus.publish({
          type: 'ui.mutate-invoked',
          op,
          args: redactMutationAuditArgs(op, args),
          result: { ok: false, code: 'internal' },
        });
        return errResult;
      }
    },

    subscribe(filter) {
      return createSubscription(deps.bus, filter);
    },

    subscribeExecutionLog(executionId) {
      // Resolve the run's log location from the persisted dispatch.runName (B2-C). When it cannot
      // be resolved (unknown id / no runName / not a cortex-run), hand back an already-closed
      // stream so the client ends cleanly rather than hanging on a tail that will never emit.
      const location = resolveExecutionLogLocation(executionId, {
        getExecution: (id) => deps.executionRegistry.getExecution(id),
      });
      if (!location) {
        const empty = createSubscription(deps.bus, { events: [] });
        empty.close();
        return empty;
      }

      // First subscriber starts the shared tailer (ref-count +1); the last close stops it (-1).
      deps.executionLogTailer.startTail(executionId, location);
      const sub = createSubscription(deps.bus, { events: ['execution.log'], executionId });

      let stopped = false;
      const close = (): void => {
        sub.close();
        if (stopped) return;
        stopped = true;
        deps.executionLogTailer.stopTail(executionId);
      };
      return {
        [Symbol.asyncIterator]: () => sub[Symbol.asyncIterator](),
        close,
      };
    },
  };
}
