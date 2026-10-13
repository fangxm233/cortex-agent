// The ui-service's dependencies, wired to the real stores and orchestration paths. Everything that
// reaches orchestration is an injected callback, so the ui-service domain never imports it.
import * as path from 'path';
import { CONTEXT_DIR } from '@core/paths.js';
import { sessionStates } from '@core/session-state.js';
import { sessionTodos } from '@core/session-todos.js';
import type { EventBus } from '@events/index.js';
import type { PlatformAdapter } from '@platform/index.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { pendingInjectionRepo } from '@store/pending-injection-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { waitpointRepo } from '@store/waitpoint-repo.js';
import {
  applyChannelSelection, clearChannelAgentSelection, getActiveProfile, getChannelOverride,
  getSelectionDefault, resolveBackendForChannel, switchChannelAgent, switchChannelProfile,
} from '@domain/agents/index.js';
import { getSubagentChildStatuses } from '@domain/agents/subagent/registry.js';
import { getCostSummary } from '@domain/costs/cost-tracker.js';
import * as executionRegistry from '@domain/executions/registry.js';
import { projectStore } from '@domain/projects/index.js';
import { getOnlineDevices, isDeviceOnline, sendCommand } from '@domain/remote/client-manager.js';
import { getMachineRegistry } from '@domain/remote/machine-registry.js';
import { isSessionCompactionSupported } from '@domain/runs/compact.js';
import type { Scheduler } from '@domain/scheduling/scheduler.js';
import { createDirectSession, adoptScheduledSession } from '@domain/sessions/session-lifecycle.js';
import { setSessionAsync } from '@domain/sessions/session.js';
import type { ServerUpdateCoordinator } from '@domain/system/server-update-coordinator.js';
import { createUiService, type UiService, type UiServiceDeps } from '@domain/ui-service/index.js';
import { cancelWaitpoint } from '@domain/waitpoints/service.js';
import { answerQuestion } from '@orch/interactions/answer-question.js';
import { interactionRecords } from '@orch/interactions/interaction-records.js';
import { planApprovals } from '@orch/interactions/plan-approvals.js';
import { respondToPlan } from '@orch/interactions/plan-response.js';
import { cancelChannelRuns, cancelLiveExecution } from '@orch/routing/commands/cancel.js';
import { deliverToSessionDetached } from '@orch/session-gateway.js';
import { compactSessionContext } from '../orchestration/session-compact.js';
import { rewindWebSession } from '../orchestration/session-rewind.js';
import { moveDraftAttachments } from './draft-attachments.js';

export interface UiServiceWiring {
  adapter: PlatformAdapter;
  bus: EventBus;
  scheduler: Scheduler;
  serverUpdateCoordinator: Pick<ServerUpdateCoordinator, 'check'>;
}

export function buildUiService(w: UiServiceWiring): UiService {
  return createUiService({
    checkServerUpdate: () => w.serverUpdateCoordinator.check(),
    projectStore,
    sessionStore,
    scheduler: w.scheduler,
    executionRegistry,
    // Only armed records are ever listed: a settled waitpoint has already announced itself in the
    // session transcript.
    waitpointRegistry: {
      list: () => waitpointRepo.list(),
      cancel: (id: string) => cancelWaitpoint(id),
    },
    approvalsPath: path.join(CONTEXT_DIR, 'PENDING_APPROVALS.md'),
    runningExecutions: sessionStates,
    costSummary: getCostSummary,
    conversationHistory,
    getSubagentChildStatuses,
    pendingInjections: pendingInjectionRepo,
    clientRegistry: clientRegistryDep(),
    bus: w.bus,
    adapter: w.adapter,
    ...sessionRunDeps(w.adapter),
    ...sessionSelectionDeps(),
    ...interactionDeps(),
  });
}

/** Machines screen: static config (getMachineRegistry) joined with live WebSocket state. */
function clientRegistryDep(): UiServiceDeps['clientRegistry'] {
  return {
    getOnlineDevices,
    isDeviceOnline,
    getMachineRegistry,
    // machines.detail expand: run the read-only telemetry probe over the existing client WebSocket.
    probeMachine: async (device, command, timeout) => {
      const result = await sendCommand(device, { action: 'bash', params: { command }, timeout });
      return typeof result?.stdout === 'string' ? result.stdout : '';
    },
  };
}

type SessionRunDeps = Pick<UiServiceDeps,
  | 'sendSessionMessage' | 'cancelSessionRun' | 'cancelLiveExecution' | 'supportsSessionCompaction'
  | 'getSessionTodos' | 'compactSession' | 'rewindSession' | 'createDirectSession'
  | 'adoptScheduledSession' | 'moveDraftAttachments'>;

/** Starting, sending to, stopping and rewinding a session's runs. */
function sessionRunDeps(adapter: PlatformAdapter): SessionRunDeps {
  return {
    sendSessionMessage: ({ channel, text, attachments }) => deliverToSessionDetached({ channel, text, attachments, origin: 'web-user' }),
    // Stop: the same channel-cancel path the no-arg/`--all` !cancel command uses.
    cancelSessionRun: ({ channel }) => cancelChannelRuns(channel),
    cancelLiveExecution,
    // Manual context compact: both the Web mutation and !compact command share the idle-only
    // orchestration coordinator; sessions.list receives the matching display capability hint.
    supportsSessionCompaction: (session) => isSessionCompactionSupported(session),
    getSessionTodos: (sessionId) => sessionTodos.get(sessionId),
    compactSession: ({ sessionId }) => compactSessionContext(sessionId),
    rewindSession: (opts) => rewindWebSession({ ...opts, adapter }),
    createDirectSession: (opts) => createDirectSession({
      sessionStore,
      setChannelSession: setSessionAsync,
      initConversation: async (channel, a) => { await conversationLedger.initConversation(channel, a); },
      resolveBackend: resolveBackendForChannel,
    }, opts),
    // Replying to a scheduled run (design 27b) adopts it as a normal direct session on its own
    // web:<sid> conduit before the send.
    adoptScheduledSession: ({ sessionId }) => adoptScheduledSession(sessionStore, sessionId),
    // Draft uploads are promoted into the newly-created session before its first turn is sent.
    moveDraftAttachments,
  };
}

type SessionSelectionDeps = Pick<UiServiceDeps,
  | 'switchSessionProfile' | 'switchSessionAgent' | 'applySessionSelection'
  | 'getChannelSelectionOverride' | 'getSelectionDefault'>;

/** The profile / agent / model a session runs: the same domain rules the chat commands apply. */
function sessionSelectionDeps(): SessionSelectionDeps {
  return {
    switchSessionProfile: (opts) => switchChannelProfile(opts),
    // A null name is the "follow the global default" row, which clears the channel's selection.
    switchSessionAgent: async ({ channel, name }) => {
      if (name === null) {
        await clearChannelAgentSelection(channel);
        return { ok: true, agentName: null, effectiveProfile: getActiveProfile(channel) ?? '', backendChanged: false };
      }
      const res = await switchChannelAgent({ channel, name });
      return res.ok === true
        ? { ok: true, agentName: res.agentName, effectiveProfile: res.effectiveProfile, backendChanged: res.backendChanged }
        : {
          ok: false, agentName: null, effectiveProfile: '', backendChanged: false,
          reason: res.reason, currentBackend: res.currentBackend, targetBackend: res.targetBackend,
        };
    },
    applySessionSelection: (opts) => applyChannelSelection(opts),
    getChannelSelectionOverride: (channel) => getChannelOverride(channel),
    // What a draft composer starts on before any session exists.
    getSelectionDefault: () => getSelectionDefault(),
  };
}

type InteractionDeps = Pick<UiServiceDeps,
  'getPendingAskUser' | 'getPendingPlan' | 'isInteractionPending' | 'answerQuestion' | 'respondPlan'>;

/** Pending ask-user / plan-approval cards, served from the interaction entity index. */
function interactionDeps(): InteractionDeps {
  return {
    getPendingAskUser: (channel) => {
      const entry = interactionRecords.getPendingByChannel(channel).find((e) => e.kind === 'ask-user');
      if (!entry) return null;
      // `blocking` distinguishes a session stalled on the answer from one that asked and kept
      // going (cortex_ask_user blocking:false) — only the former is "awaiting user action".
      return { requestId: entry.id, questions: entry.payload.questions ?? [], blocking: entry.payload.blocking !== false };
    },
    getPendingPlan: (channel) => {
      const entry = interactionRecords.getPendingByChannel(channel).find((e) => e.kind === 'plan-approval');
      if (!entry) return null;
      return { requestId: entry.id, planContent: entry.payload.planContent ?? '', planFilePath: entry.payload.planFilePath ?? null };
    },
    // Transcript materialization liveness signal (pending rows with no live entry derive to expired).
    isInteractionPending: (id) => interactionRecords.isPending(id),
    // Resolving persists the entity, broadcasts session.interaction to every client and unblocks
    // the waiting MCP tool. First writer wins.
    answerQuestion: (requestId, answers) => answerQuestion(requestId, answers, 'web'),
    respondPlan: (requestId, approved, feedback) => respondToPlan(
      { planApprovals, interactionRecords },
      requestId,
      approved,
      feedback,
      'web',
    ),
  };
}
