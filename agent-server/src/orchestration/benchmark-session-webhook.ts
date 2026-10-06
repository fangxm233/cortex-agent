//
// `/webhook/benchmark-session`: how the benchmark launcher runs one trial on a production server.
// `start` creates an ordinary direct session, binds the trial's evidence context to it and delivers
// the task as the session's first user message; `status` reports whether the session is still
// working and how its last turn ended. No action waits on the agent.

import type { EventBus } from '@events/index.js';
import { createLogger } from '@core/log.js';
import { parseProductionBenchmarkEvidenceContext } from '@domain/benchmark/production-benchmark-evidence.js';
import { sessionState } from '@core/session-state.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { executionRepo } from '@store/execution-repo.js';
import { createDirectSession } from '@domain/sessions/session-lifecycle.js';
import { setSessionAsync } from '@domain/sessions/session.js';
import { resolveBackendForChannel } from '@domain/agents/index.js';
import { bindSessionEvidenceContext, sessionForRun } from '@domain/benchmark/session-evidence.js';
import { conduitQueues } from './conduit-queue.js';
import { orchestrationBus } from './runtime.js';
import { deliverToSession } from './session-gateway.js';

const log = createLogger('benchmark-session');

export interface BenchmarkSessionReply {
  success: boolean;
  data?: unknown;
  error?: string;
}

type TurnStatus = 'completed' | 'failed' | 'stopped';

interface TrackedSession {
  channel: string;
  /** The task delivery has not returned yet: the first turn is still being admitted or run. */
  delivering: boolean;
  deliveryError: string | null;
  turns: Array<{ status: TurnStatus; finalOutput: string }>;
}

export interface BenchmarkSessionDeps {
  createSession(projectId: string): Promise<{ sessionId: string; channel: string }>;
  deliver(channel: string, text: string): Promise<void>;
  /** A live turn, a background hold, or a queued message on the session's channel. */
  isBusy(sessionId: string, channel: string): boolean;
  executionIds(sessionId: string): string[];
  bus(): EventBus | null;
}

const defaultDeps: BenchmarkSessionDeps = {
  createSession: (projectId) => createDirectSession({
    sessionStore,
    setChannelSession: setSessionAsync,
    initConversation: async (channel, a) => { await conversationLedger.initConversation(channel, a); },
    resolveBackend: resolveBackendForChannel,
  }, { projectId }),
  deliver: (channel, text) => deliverToSession({ channel, text, origin: 'web-user' }),
  isBusy: (sessionId, channel) => sessionState(sessionId).running || conduitQueues.has(channel),
  executionIds: (sessionId) => executionRepo.getAllExecutions()
    .filter(record => record.session.sessionId === sessionId)
    .sort((a, b) => a.runtime.startedAt.localeCompare(b.runtime.startedAt))
    .map(record => record.id),
  bus: () => orchestrationBus(),
};

const tracked = new Map<string, TrackedSession>();
const startingRuns = new Set<string>();
let subscribedBus: EventBus | null = null;

class BenchmarkSessionError extends Error {}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function ok(data: Record<string, unknown>): BenchmarkSessionReply {
  return { success: true, data };
}

function subscribeTurns(deps: BenchmarkSessionDeps): void {
  const bus = deps.bus();
  if (!bus || bus === subscribedBus) return;
  subscribedBus = bus;
  bus.subscribe('session.turn.completed', (event) => {
    tracked.get(event.sessionId)?.turns.push({ status: event.status, finalOutput: event.finalOutput });
  });
}

async function start(data: Record<string, any>, deps: BenchmarkSessionDeps): Promise<BenchmarkSessionReply> {
  const message = str(data.message);
  if (!message) throw new BenchmarkSessionError('message required');
  const context = parseProductionBenchmarkEvidenceContext(data.productionBenchmarkEvidenceContext);
  const run = `${context.trial_id}/${context.root_run_id}`;
  if (startingRuns.has(run) || sessionForRun(context.trial_id, context.root_run_id)) {
    throw new BenchmarkSessionError(`trial run ${run} already has a session`);
  }
  startingRuns.add(run);
  try {
    subscribeTurns(deps);
    const { sessionId, channel } = await deps.createSession(str(data.projectId) || 'general');
    // Bound before the delivery, so the first turn's runs already carry the context.
    bindSessionEvidenceContext(sessionId, context);
    const entry: TrackedSession = { channel, delivering: true, deliveryError: null, turns: [] };
    tracked.set(sessionId, entry);
    void deps.deliver(channel, message).then(
      () => { entry.delivering = false; },
      (error: unknown) => {
        entry.delivering = false;
        entry.deliveryError = (error as Error)?.message ?? String(error);
        log.error(`benchmark session ${sessionId} delivery failed: ${entry.deliveryError}`);
      },
    );
    log.info(`benchmark session ${sessionId} started for trial run ${run}`);
    return ok({ sessionId, channel, status: 'running' });
  } finally {
    startingRuns.delete(run);
  }
}

async function status(data: Record<string, any>, deps: BenchmarkSessionDeps): Promise<BenchmarkSessionReply> {
  const sessionId = str(data.sessionId);
  const entry = tracked.get(sessionId);
  if (!entry) throw new BenchmarkSessionError(`not a benchmark session: ${sessionId || '(none)'}`);
  const running = entry.delivering || deps.isBusy(sessionId, entry.channel);
  const last = entry.turns.at(-1) ?? null;
  const outcome = running ? 'running'
    : entry.deliveryError ? 'failed'
      : last?.status ?? 'failed';
  return ok({
    sessionId,
    channel: entry.channel,
    running,
    terminal: !running,
    status: outcome,
    turns: entry.turns.length,
    finalOutput: last?.finalOutput ?? null,
    error: entry.deliveryError,
    executionIds: deps.executionIds(sessionId),
  });
}

async function ping(): Promise<BenchmarkSessionReply> {
  return ok({ ready: true });
}

const ACTIONS: Record<string, (data: Record<string, any>, deps: BenchmarkSessionDeps) => Promise<BenchmarkSessionReply>> = {
  start, status, ping,
};

export async function handleBenchmarkSessionWebhook(
  data: Record<string, any>,
  deps: BenchmarkSessionDeps = defaultDeps,
): Promise<BenchmarkSessionReply> {
  try {
    const action = ACTIONS[str(data?.action)];
    if (!action) return { success: false, error: `unknown action: ${String(data?.action)}` };
    return await action(data, deps);
  } catch (error) {
    if (!(error instanceof BenchmarkSessionError)) {
      log.error(`benchmark-session ${String(data?.action)} failed: ${(error as Error).message}`);
    }
    return { success: false, error: (error as Error).message };
  }
}

export function _resetBenchmarkSessions(): void {
  tracked.clear();
  startingRuns.clear();
  subscribedBus = null;
}
