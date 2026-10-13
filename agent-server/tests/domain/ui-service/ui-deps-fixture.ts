import { EventBus } from '../../../src/events/event-bus.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

type NestedDep = 'sessionStore' | 'conversationHistory' | 'clientRegistry';

/** Top-level overrides replace the default; the nested stores are merged member by member. */
export type UiDepsOverrides = Partial<Omit<UiServiceDeps, NestedDep>> & {
  [K in NestedDep]?: Partial<UiServiceDeps[K]>;
};

/** A complete, inert `UiServiceDeps`. A suite overrides only the fields its handler reads. */
export function makeUiDeps(overrides: UiDepsOverrides = {}): UiServiceDeps {
  const base: UiServiceDeps = {
    checkServerUpdate: async () => ({ status: 'error', reason: 'check_failed' }),
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: {
      listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null,
      touchSessionUse: async () => true, markRead: async () => {}, setStarred: async () => null, rename: async () => null,
      bindCommission: async () => null, setCommissionDraft: async () => null,
    },
    supportsSessionCompaction: () => false,
    getSessionTodos: () => null,
    compactSession: async () => ({ ok: false, reason: 'unsupported' }),
    getSubagentChildStatuses: () => new Map(),
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    waitpointRegistry: { list: async () => [], cancel: async () => ({ cancelled: false }) },
    conversationHistory: {
      getHistory: async () => null,
      getCompactHistoryAt: async () => ({ value: null, cursor: '' }),
      getSubagentHistory: async (sessionId, subagentId) => ({ sessionId, subagentId, events: [] }),
      getToolDebugDetails: async () => null,
      getFirstUserText: async () => null,
      appendDecisionAction: async () => {},
    },
    pendingInjections: { listBySession: async () => [] },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, unpricedCount: 0, dailyBudget: 0, monthlyBudget: 0, budgetScope: 'global' as const, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: new EventBus(),
    createDirectSession: async () => ({ sessionId: '', channel: '' }),
    adoptScheduledSession: async () => null,
    moveDraftAttachments: async ({ attachments }) => attachments,
    cancelSessionRun: async () => 0,
    cancelLiveExecution: async () => false,
    rewindSession: async () => ({ ok: false, reason: 'not-found' }),
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    switchSessionAgent: async () => ({ ok: false, agentName: null, effectiveProfile: '', backendChanged: false, reason: 'unknown-agent' }),
    applySessionSelection: async () => ({ ok: false, backendChanged: false, profileName: '', backend: 'claude', model: '', provider: null, thinking: null, mode: '', override: null, reason: 'unknown-profile' }),
    getChannelSelectionOverride: () => null,
    getSelectionDefault: () => null,
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}), probeMachine: async () => '' },
    adapter: { getProjectConduits: async () => ({}) } as any,
    getPendingAskUser: () => null,
    getPendingPlan: () => null,
    answerQuestion: () => 'not-found',
    respondPlan: () => 'not-found',
    isInteractionPending: () => false,
  };
  const { sessionStore, conversationHistory, clientRegistry, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    sessionStore: mergeNested(base.sessionStore, sessionStore),
    conversationHistory: mergeNested(base.conversationHistory, conversationHistory),
    clientRegistry: mergeNested(base.clientRegistry, clientRegistry),
  };
}

/** A plain-object override is merged over the default; a class instance (a real store) is used as is. */
function mergeNested<T extends object>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  if (Object.getPrototypeOf(override) !== Object.prototype) return override as T;
  return { ...base, ...override };
}
