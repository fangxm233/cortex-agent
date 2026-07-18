// Zod input schemas for every ui-service query scope and mutate op.
//
// Source of truth lives in agent-server (`domain/ui-service/input-schemas.ts`) so the
// tRPC AppRouter can consume the schemas without agent-server importing this package —
// that import would close a workspace build cycle (this package re-exports agent-server
// types). We re-export the BUILT schema values here (runtime + types), giving the frontend
// one definition it shares with the backend. `contract.parity.ts` still compile-guards them
// against QueryParamMap / MutateArgsMap.

export {
  projectsListInput,
  projectsCreateInput,
  sessionsListInput,
  sessionsTranscriptInput,
  sessionsCreateInput,
  sessionsSendInput,
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
  systemRestartInput,
  sessionsAnswerQuestionInput,
  sessionsRespondPlanInput,
  sessionsPendingInteractionInput,
  queryInputSchemas,
  mutateInputSchemas,
} from '@cortex-agent/server/dist/domain/ui-service/input-schemas.js';
