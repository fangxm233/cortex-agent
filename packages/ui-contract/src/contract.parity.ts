// input:  shared zod schemas and agent-server query/mutation maps
// output: exact-parity guards including session compact/rate limits
// pos:    Anti-drift boundary for the shared UI contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { z } from 'zod';
import type { QueryParamMap, MutateArgsMap, ExecutionsLogParams } from './dto.js';
import type {
  projectsListInput,
  projectsCreateInput,
  sessionsListInput,
  sessionsTranscriptInput,
  sessionsCreateInput,
  sessionsSendInput,
  sessionsCompactInput,
  sessionsSetProfileInput,
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
  machinesListInput,
  skillsListInput,
  threadTemplatesGetInput,
  systemDaemonStatusInput,
  systemRateLimitStatusInput,
  systemRestartInput,
} from './schemas.js';

// Mutual assignability: true only when A and B are structurally equivalent.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type QueryParity<S extends keyof QueryParamMap, Schema extends z.ZodType> = Exact<
  z.infer<Schema>,
  QueryParamMap[S]
>;
type MutateParity<O extends keyof MutateArgsMap, Schema extends z.ZodType> = Exact<
  z.infer<Schema>,
  MutateArgsMap[O]
>;

// ── Query scopes ──────────────────────────────────────────────────
const _projectsList: QueryParity<'projects.list', typeof projectsListInput> = true;
const _sessionsList: QueryParity<'sessions.list', typeof sessionsListInput> = true;
const _sessionsTranscript: QueryParity<'sessions.transcript', typeof sessionsTranscriptInput> = true;
const _threadsList: QueryParity<'threads.list', typeof threadsListInput> = true;
const _threadsGet: QueryParity<'threads.get', typeof threadsGetInput> = true;
const _tasksList: QueryParity<'tasks.list', typeof tasksListInput> = true;
const _taskVerification: QueryParity<'tasks.verification', typeof taskVerificationInput> = true;
const _schedulesList: QueryParity<'schedules.list', typeof schedulesListInput> = true;
const _executionsList: QueryParity<'executions.list', typeof executionsListInput> = true;
const _executionsGet: QueryParity<'executions.get', typeof executionsGetInput> = true;
const _memoryTree: QueryParity<'memory.tree', typeof memoryTreeInput> = true;
const _memoryFile: QueryParity<'memory.file', typeof memoryFileInput> = true;
const _approvalsList: QueryParity<'approvals.list', typeof approvalsListInput> = true;
const _issuesList: QueryParity<'issues.list', typeof issuesListInput> = true;
const _costSummary: QueryParity<'cost.summary', typeof costSummaryInput> = true;
const _configGet: QueryParity<'config.get', typeof configGetInput> = true;
const _machinesList: QueryParity<'machines.list', typeof machinesListInput> = true;
const _skillsList: QueryParity<'skills.list', typeof skillsListInput> = true;
const _threadTemplatesGet: QueryParity<'threadTemplates.get', typeof threadTemplatesGetInput> = true;
const _systemDaemonStatus: QueryParity<'system.daemonStatus', typeof systemDaemonStatusInput> = true;
const _systemRateLimitStatus: QueryParity<'system.rateLimitStatus', typeof systemRateLimitStatusInput> = true;

// ── Mutate ops ────────────────────────────────────────────────────
const _projectsCreate: MutateParity<'projects.create', typeof projectsCreateInput> = true;
const _sessionsCreate: MutateParity<'sessions.create', typeof sessionsCreateInput> = true;
const _sessionsSend: MutateParity<'sessions.send', typeof sessionsSendInput> = true;
const _sessionsCompact: MutateParity<'sessions.compact', typeof sessionsCompactInput> = true;
const _sessionsSetProfile: MutateParity<'sessions.setProfile', typeof sessionsSetProfileInput> = true;
const _threadsCancel: MutateParity<'threads.cancel', typeof threadsCancelInput> = true;
const _executionsCancel: MutateParity<'executions.cancel', typeof executionsCancelInput> = true;
const _schedulesPause: MutateParity<'schedules.pause', typeof scheduleActionInput> = true;
const _schedulesResume: MutateParity<'schedules.resume', typeof scheduleActionInput> = true;
const _schedulesRemove: MutateParity<'schedules.remove', typeof scheduleActionInput> = true;
const _schedulesAdd: MutateParity<'schedules.add', typeof scheduleAddInput> = true;
const _tasksClaim: MutateParity<'tasks.claim', typeof taskActionInput> = true;
const _tasksUnclaim: MutateParity<'tasks.unclaim', typeof taskActionInput> = true;
const _tasksComplete: MutateParity<'tasks.complete', typeof taskCompleteInput> = true;
const _tasksBlock: MutateParity<'tasks.block', typeof taskBlockInput> = true;
const _tasksUnblock: MutateParity<'tasks.unblock', typeof taskActionInput> = true;
const _configSet: MutateParity<'config.set', typeof configSetInput> = true;
const _approvalsApprove: MutateParity<'approvals.approve', typeof approvalsApproveInput> = true;
const _approvalsReject: MutateParity<'approvals.reject', typeof approvalsRejectInput> = true;
const _approvalsRequest: MutateParity<'approvals.request', typeof approvalsRequestInput> = true;
const _issuesHandle: MutateParity<'issues.handle', typeof issueActionInput> = true;
const _issuesDelete: MutateParity<'issues.delete', typeof issueActionInput> = true;
const _systemRestart: MutateParity<'system.restart', typeof systemRestartInput> = true;

// ── Subscriptions ─────────────────────────────────────────────────
// Subscriptions have no query/mutate map entry; guard the input schema against its backend
// param type directly (B2-C executions.log).
const _executionsLog: Exact<z.infer<typeof executionsLogInput>, ExecutionsLogParams> = true;

// Reference the guards so noUnusedLocals (if enabled) stays quiet and the
// checks are not tree-shaken away by the type checker.
export const _contractParityChecked = [
  _projectsList, _sessionsList, _sessionsTranscript, _threadsList, _threadsGet, _tasksList, _schedulesList,
  _executionsList, _executionsGet, _memoryTree, _memoryFile, _approvalsList, _costSummary, _configGet,
  _machinesList, _skillsList, _threadTemplatesGet,
  _projectsCreate, _sessionsCreate, _sessionsSend, _sessionsCompact, _sessionsSetProfile, _threadsCancel, _executionsCancel,
  _schedulesPause, _schedulesResume, _schedulesRemove, _schedulesAdd, _tasksClaim,
  _tasksUnclaim, _tasksComplete, _tasksBlock, _tasksUnblock,
  _approvalsApprove, _approvalsReject, _approvalsRequest, _issuesList, _issuesHandle, _issuesDelete,
  _configSet, _executionsLog,
  _systemDaemonStatus, _systemRateLimitStatus, _systemRestart,
] as const;
