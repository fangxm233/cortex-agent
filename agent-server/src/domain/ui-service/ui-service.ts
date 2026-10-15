import type {
  UiServiceDeps, UiService, QueryScope, MutateOp, Result, QueryParams, QueryReturn, MutateArgs, MutateReturn,
} from './types.js';
import { handleProjectsList } from './query/projects.js';
import { handleSetStarred, handleRenameSession } from './mutate/session-metadata.js';
import {
  handleSessionsList,
  handleSessionsTranscript,
  handleSessionsSubagentTranscript,
  handleSessionsDebugDetails,
  handleSessionsPendingInteraction,
} from './query/sessions.js';
import { handleSchedulesList } from './query/schedules.js';
import {
  handleBoardsList,
  handleBoardsGet,
  handleBoardsDecisions,
  handleBoardsStyle,
} from './query/boards.js';
import { handleExecutionsList, handleExecutionsGet } from './query/executions.js';
import { handleWaitpointsList } from './query/waitpoints.js';
import { handleMemoryTree, handleMemoryFile } from './query/memory.js';
import { handleApprovalsList } from './query/approvals.js';
import { handleIssuesList } from './query/issues.js';
import { handleNotesList } from './query/notes.js';
import { handleCostSummary } from './query/cost.js';
import { handlePlatformSettingsSet } from './mutate/platform-settings.js';
import { handleConfigGet } from './query/config.js';
import { handleAuthFlowState, handleAuthStatus } from './query/auth.js';
import { handleCustomProvidersList } from './query/custom-providers.js';
import { handleUsageSharingGet } from './query/usage-sharing.js';
import { handleModelsCatalog } from './query/models.js';
import { handleHooksList } from './query/hooks.js';
import { handleMachinesList } from './query/machines.js';
import { handleMachineDetail } from './query/machine-detail.js';
import { handleSkillsList, handleSkillsSession } from './query/skills.js';
import { handlePluginsList } from './query/plugins.js';
import { handlePluginsSkillFile, handlePluginsMcpRead } from './query/plugin-source.js';
import { handleEnvironmentsList, handleEnvironmentsGet } from './query/environments.js';
import {
  handleSystemDaemonStatus,
  handleSystemRateLimitStatus,
  handleSystemUsageStatus,
  handleSystemNotices,
  handleSystemUpdateStatus,
} from './query/system.js';
import {
  handleConfigSet,
  handleConfigSetProviderRateLimitPolicy,
} from './mutate/config.js';
import {
  handleHooksCreate,
  handleHooksUpdate,
  handleHooksSetEnabled,
  handleHooksRemove,
  handleHooksTest,
} from './mutate/hooks.js';
import {
  handleModelsFavoriteAdd,
  handleModelsFavoriteRemove,
  handleModelsSetDefault,
} from './mutate/models.js';
import {
  handleEnvironmentsValidate,
  handleEnvironmentsSave,
  handleEnvironmentsDelete,
  handleEnvironmentsSavePrompt,
} from './mutate/environments.js';
import { handlePluginsAssign } from './mutate/plugins.js';
import {
  handlePluginsSkillWrite,
  handlePluginsSkillCreate,
  handlePluginsSkillMove,
  handlePluginsSkillRemove,
  handlePluginsSkillRevert,
  handlePluginsCreate,
  handlePluginsRemove,
  handlePluginsConvertToPortable,
  handlePluginsMcpWrite,
} from './mutate/plugin-packages.js';
import { handleCreateProject } from './mutate/projects.js';
import { handleCreateSession, handleSendSession, handleCancelSession, handleCompactSession, handleSetAgent, handleSetSelection, handleCreateAndSend, handleMarkReadSession, handleMarkManyReadSessions, handleAnswerQuestion, handleRespondPlan, handleRespondDecision, handleCancelResume, handleRewindSession } from './mutate/sessions.js';
import { handleCancelExecution } from './mutate/executions.js';
import { handleCancelWaitpoint } from './mutate/waitpoints.js';
import {
  handlePauseSchedule,
  handleResumeSchedule,
  handleRemoveSchedule,
  handleAddSchedule,
  handleUpdateSchedule,
} from './mutate/schedules.js';
import { handleApproveApproval, handleRejectApproval, handleRequestApproval } from './mutate/approvals.js';
import { handleIssuesDelete, handleIssuesHandle } from './mutate/issues.js';
import {
  handleNotesAdd,
  handleNotesClearCompleted,
  handleNotesDelete,
  handleNotesSetCompleted,
  handleNotesUpdate,
} from './mutate/notes.js';
import {
  handleSystemRestart,
  handleSystemClearRateLimit,
  handleSystemRefreshUsage,
  handleSystemRedeemUsageReset,
  handleSystemCheckUpdate,
  handleSystemApplyUpdate,
  handleSystemSkipUpdate,
} from './mutate/system.js';
import {
  handleAuthCancelFlow,
  handleAuthLogout,
  handleAuthSyncGateway,
  handleAuthRespondPrompt,
  handleAuthStartLogin,
} from './mutate/auth.js';
import {
  handleCustomProviderRemove,
  handleCustomProviderUpsert,
} from './mutate/custom-providers.js';
import { handleUsageSharingSet } from './mutate/usage-sharing.js';
import { createSubscription } from './subscribe.js';
import { AssistantSnapshots } from './assistant-snapshots.js';

/** One handler per query scope; a missing or mistyped handler fails compilation. */
export type QueryHandlerMap = {
  [S in QueryScope]: (deps: UiServiceDeps, params: QueryParams<S>) => Promise<QueryReturn<S>>;
};
/** One handler per mutate op; a missing or mistyped handler fails compilation. */
export type MutateHandlerMap = {
  [O in MutateOp]: (deps: UiServiceDeps, args: MutateArgs<O>) => Promise<Result<MutateReturn<O>>>;
};

export const queryHandlers = {
  'projects.list': (deps) => handleProjectsList(deps),
  'sessions.list': (deps, params) => handleSessionsList(deps, params),
  'sessions.transcript': (deps, params) => handleSessionsTranscript(deps, params),
  'sessions.subagentTranscript': (deps, params) => handleSessionsSubagentTranscript(deps, params),
  'sessions.debugDetails': (deps, params) => handleSessionsDebugDetails(deps, params),
  'sessions.pendingInteraction': (deps, params) => handleSessionsPendingInteraction(deps, params),
  'schedules.list': (deps, params) => handleSchedulesList(deps, params),
  'boards.list': (deps, params) => handleBoardsList(deps, params),
  'boards.get': (deps, params) => handleBoardsGet(deps, params),
  'boards.decisions': (deps, params) => handleBoardsDecisions(deps, params),
  'boards.style': (deps, params) => handleBoardsStyle(deps, params),
  'executions.list': (deps, params) => handleExecutionsList(deps, params),
  'waitpoints.list': (deps, params) => handleWaitpointsList(deps, params),
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
  'auth.customProviders': (deps, params) => handleCustomProvidersList(deps, params),
  'usageSharing.get': (deps, params) => handleUsageSharingGet(deps, params),
  'models.catalog': (deps, params) => handleModelsCatalog(deps, params),
  'hooks.list': (deps, params) => handleHooksList(deps, params),
  'machines.list': (deps, params) => handleMachinesList(deps, params),
  'machines.detail': (deps, params) => handleMachineDetail(deps, params),
  'skills.list': (deps, params) => handleSkillsList(deps, params),
  'skills.session': (deps, params) => handleSkillsSession(deps, params),
  'plugins.list': (deps, params) => handlePluginsList(deps, params),
  'plugins.skillFile': (deps, params) => handlePluginsSkillFile(deps, params),
  'plugins.mcpRead': (deps, params) => handlePluginsMcpRead(deps, params),
  'environments.list': (deps, params) => handleEnvironmentsList(deps, params),
  'environments.get': (deps, params) => handleEnvironmentsGet(deps, params),
  'system.daemonStatus': (_deps, params) => handleSystemDaemonStatus(params),
  'system.rateLimitStatus': (_deps, params) => handleSystemRateLimitStatus(params),
  'system.usageStatus': (_deps, params) => handleSystemUsageStatus(params),
  'system.notices': (_deps, params) => handleSystemNotices(params),
  'system.updateStatus': (_deps, params) => handleSystemUpdateStatus(params),
} satisfies QueryHandlerMap;

export const mutateHandlers = {
  'projects.create': (deps, args) => handleCreateProject(deps, args),
  'sessions.create': (deps, args) => handleCreateSession(deps, args),
  'sessions.send': (deps, args) => handleSendSession(deps, args),
  'sessions.cancel': (deps, args) => handleCancelSession(deps, args),
  'sessions.compact': (deps, args) => handleCompactSession(deps, args),
  'sessions.setAgent': (deps, args) => handleSetAgent(deps, args),
  'sessions.setSelection': (deps, args) => handleSetSelection(deps, args),
  'sessions.createAndSend': (deps, args) => handleCreateAndSend(deps, args),
  'sessions.setStarred': (deps, args) => handleSetStarred(deps, args),
  'sessions.rename': (deps, args) => handleRenameSession(deps, args),
  'sessions.markRead': (deps, args) => handleMarkReadSession(deps, args),
  'sessions.markManyRead': (deps, args) => handleMarkManyReadSessions(deps, args),
  'sessions.answerQuestion': (deps, args) => handleAnswerQuestion(deps, args),
  'sessions.respondPlan': (deps, args) => handleRespondPlan(deps, args),
  'sessions.respondDecision': (deps, args) => handleRespondDecision(deps, args),
  'sessions.cancelResume': (_deps, args) => handleCancelResume(args),
  'sessions.rewind': (deps, args) => handleRewindSession(deps, args),
  'executions.cancel': (deps, args) => handleCancelExecution(deps, args),
  'waitpoints.cancel': (deps, args) => handleCancelWaitpoint(deps, args),
  'schedules.pause': (deps, args) => handlePauseSchedule(deps, args),
  'schedules.resume': (deps, args) => handleResumeSchedule(deps, args),
  'schedules.remove': (deps, args) => handleRemoveSchedule(deps, args),
  'schedules.add': (deps, args) => handleAddSchedule(deps, args),
  'schedules.update': (deps, args) => handleUpdateSchedule(deps, args),
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
  'config.setPlatform': (_deps, args) => handlePlatformSettingsSet(args),
  'config.setProviderRateLimitPolicy': (deps, args) => handleConfigSetProviderRateLimitPolicy(deps, args),
  'auth.startLogin': (deps, args) => handleAuthStartLogin(deps, args),
  'auth.respondPrompt': (deps, args) => handleAuthRespondPrompt(deps, args),
  'auth.cancelFlow': (deps, args) => handleAuthCancelFlow(deps, args),
  'auth.logout': (deps, args) => handleAuthLogout(deps, args),
  'auth.syncGateway': (deps, args) => handleAuthSyncGateway(deps, args),
  'auth.upsertCustomProvider': (deps, args) => handleCustomProviderUpsert(deps, args),
  'auth.removeCustomProvider': (deps, args) => handleCustomProviderRemove(deps, args),
  'usageSharing.set': (deps, args) => handleUsageSharingSet(deps, args),
  'hooks.create': (deps, args) => handleHooksCreate(deps, args),
  'hooks.update': (deps, args) => handleHooksUpdate(deps, args),
  'hooks.setEnabled': (deps, args) => handleHooksSetEnabled(deps, args),
  'hooks.remove': (deps, args) => handleHooksRemove(deps, args),
  'hooks.test': (deps, args) => handleHooksTest(deps, args),
  'models.favorites.add': (deps, args) => handleModelsFavoriteAdd(deps, args),
  'models.favorites.remove': (deps, args) => handleModelsFavoriteRemove(deps, args),
  'models.setDefault': (deps, args) => handleModelsSetDefault(deps, args),
  'plugins.assign': (deps, args) => handlePluginsAssign(deps, args),
  'plugins.skillWrite': (deps, args) => handlePluginsSkillWrite(deps, args),
  'plugins.skillCreate': (deps, args) => handlePluginsSkillCreate(deps, args),
  'plugins.skillMove': (deps, args) => handlePluginsSkillMove(deps, args),
  'plugins.skillRemove': (deps, args) => handlePluginsSkillRemove(deps, args),
  'plugins.skillRevert': (deps, args) => handlePluginsSkillRevert(deps, args),
  'plugins.create': (deps, args) => handlePluginsCreate(deps, args),
  'plugins.remove': (deps, args) => handlePluginsRemove(deps, args),
  'plugins.convertToPortable': (deps, args) => handlePluginsConvertToPortable(deps, args),
  'plugins.mcpWrite': (deps, args) => handlePluginsMcpWrite(deps, args),
  'environments.validate': (deps, args) => handleEnvironmentsValidate(deps, args),
  'environments.save': (deps, args) => handleEnvironmentsSave(deps, args),
  'environments.delete': (deps, args) => handleEnvironmentsDelete(deps, args),
  'environments.savePrompt': (deps, args) => handleEnvironmentsSavePrompt(deps, args),
  'system.restart': (_deps, args) => handleSystemRestart(args),
  'system.clearRateLimit': (_deps, args) => handleSystemClearRateLimit(args),
  'system.refreshUsage': (_deps, args) => handleSystemRefreshUsage(args),
  'system.redeemUsageReset': (_deps, args) => handleSystemRedeemUsageReset(args),
  'system.checkUpdate': handleSystemCheckUpdate,
  'system.applyUpdate': (_deps, args) => handleSystemApplyUpdate(args),
  'system.skipUpdate': (_deps, args) => handleSystemSkipUpdate(args),
} satisfies MutateHandlerMap;

type AuditArgs = Record<string, unknown>;

/** Ops whose arguments carry secrets or personal data the audit event must not record. */
const AUDIT_REDACTORS: Partial<Record<MutateOp, (args: AuditArgs) => unknown>> = {
  'auth.respondPrompt': ({ flowId }) => ({ flowId }),
  'auth.upsertCustomProvider': ({ apiKey: _upstreamKey, ...safe }) => safe,
  'usageSharing.set': ({ enabled }) => ({ enabled }),
};

function dropNoteText({ text: _privateText, ...safe }: AuditArgs): AuditArgs {
  return safe;
}

export function redactMutationAuditArgs(op: MutateOp, args: unknown): unknown {
  if (op === 'config.setPlatform') return { redacted: true };
  if (!args || typeof args !== 'object') return args;
  const redact = AUDIT_REDACTORS[op] ?? (op.startsWith('notes.') ? dropNoteText : undefined);
  return redact ? redact(args as AuditArgs) : args;
}

export function createUiService(deps: UiServiceDeps): UiService {
  const assistantSnapshots = new AssistantSnapshots(deps.bus);
  return {
    async query(scope, params) {
      const handler: QueryHandlerMap[typeof scope] | undefined = (queryHandlers as QueryHandlerMap)[scope];
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
      const handler: MutateHandlerMap[typeof op] | undefined = (mutateHandlers as MutateHandlerMap)[op];
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
      return createSubscription(deps.bus, filter, assistantSnapshots);
    },

  };
}
