// input:  AgentRunner.route driving the REAL _executeReal against a faked `startRun`
// output: characterization (golden) traces of one conversation turn's side-effect ORDER
// pos:    Phase 0 safety net for plan/orchestration-turn-refactor.md. Phase 1 lifts the turn
//         skeleton out of `agent-runner._executeReal` into `orchestration/turn/turn.ts`; these
//         four traces must keep passing UNCHANGED across that move. They are deliberately
//         whole-array `toEqual` assertions, not `toContain` — the ORDER is the contract.
//
// Only seams that do not bypass `_executeReal` are injected (`enqueue`, `track`, `tryInject`);
// `execute` is NOT injected, so the real turn body runs.

import '../_test-home.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { mockStartRun } = vi.hoisted(() => ({ mockStartRun: vi.fn() }));

// The one backend seam. Everything above it (status message, ledger turn tracking, session
// lease, publish bracket, terminal render) is production code.
vi.mock('@domain/runs/service.js', () => ({
  startRun: (...args: unknown[]) => mockStartRun(...args),
}));

// Same two mocks the existing orchestration suites use to make the request assembly deterministic
// without a profiles/agents fixture (see tests/orch/first-turn-interrupt-resume.test.ts).
vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getDefaultAgent: () => 'main',
    getActiveProfile: () => 'default',
    resolveBackendForChannel: () => 'claude',
  };
});

vi.mock('@domain/threads/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    resolveAgentSlotConfigByName: (name: string) => ({
      slotId: name,
      profile: '__active__',
      persistSession: false,
      directive: '',
      systemPrompt: null,
      promptTemplate: '{{input}}',
      claudeAgent: null,
      outputStyle: null,
      tools: null,
      pluginDirs: null,
    }),
  };
});

import type { AgentResult } from '../../src/core/types/agent-types.js';
import type { Destination, MessageContent, MessageRef, PostMessageOpts } from '../../src/platform/types.js';
import type { AgentRun } from '../../src/domain/runs/run.js';
import { AgentRunner } from '../../src/orchestration/agent-runner.js';
import { markPendingTurnSuperseded } from '../../src/orchestration/turn/turn-tracking.js';
import { getOrchestrationRuntime, setOrchestrationRuntime } from '../../src/orchestration/runtime.js';
import { conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { setSessionAsync } from '../../src/domain/sessions/session.js';
import { MockAdapter } from '../../src/platform/testing.js';

// --- the trace ------------------------------------------------------------

/** Records one turn's side effects, in the order they happen. */
type Trace = string[];

/** `postMessage` with richBlocks is the turn's status message; without, it is prose
 *  (the error body, a turn-complete notification). */
function postLabel(content: MessageContent): string {
  return content.richBlocks && content.richBlocks.length > 0 ? 'status' : 'text';
}

/** The Cancel button is the only action element that distinguishes the live status update
 *  (onExecutionStarted) from the terminal seal (sealStatus). */
function updateLabel(content: MessageContent): string {
  const hasCancel = (content.richBlocks ?? []).some(
    (block) => block.type === 'actions'
      && (block as { elements?: Array<{ actionId?: string }> }).elements?.some((e) => e.actionId === 'status_cancel'),
  );
  return hasCancel ? 'cancel' : 'seal';
}

class TracingAdapter extends MockAdapter {
  constructor(private readonly trace: Trace) { super(); }

  override async postMessage(destination: Destination, content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef> {
    this.trace.push(`postMessage(${postLabel(content)})`);
    return super.postMessage(destination, content, opts);
  }

  override async updateMessage(ref: MessageRef, content: MessageContent): Promise<void> {
    this.trace.push(`updateMessage(${updateLabel(content)})`);
    return super.updateMessage(ref, content);
  }
}

// --- the fake run ---------------------------------------------------------

function agentResult(partial: Partial<AgentResult> = {}): AgentResult {
  return {
    finalOutput: 'ok',
    total_cost_usd: 0,
    num_turns: 1,
    pendingBackgroundTasks: 0,
    undeliveredBackgroundTasks: 0,
    ...partial,
  } as AgentResult;
}

/** The slice of `AgentRun` a conversation turn touches: id/result/settled, an empty capability
 *  set (⇒ `canAwaitBackground:false`, so no background hold), and inert control verbs. */
function fakeRun(result: Promise<AgentResult>): AgentRun {
  return {
    id: 'run-golden',
    executionId: 'exec-golden',
    status: 'running',
    phase: 'foreground',
    numTurns: null,
    backendSessionId: 'backend-golden',
    capabilities: new Set(),
    result,
    settled: result,
    steer: async () => 'refused',
    respondToDialog: () => false,
    cancel: () => {},
    subscribe: () => () => {},
    backgroundTranscriptOwned: false,
    claimBackgroundTranscript: () => {},
    ingestExternal: () => false,
  } as unknown as AgentRun;
}

// --- the harness ----------------------------------------------------------

interface TurnCase {
  channel: string;
  sessionName: string;
  trackSessionId: string;
  /** What the faked `startRun` does. */
  run: () => AgentRun;
  /** Fires while the ledger turn is still pending (on the user-message publish). */
  onUserMessagePublished?: (channel: string) => void;
}

let restoreBus: unknown;
let restoreDebug: string | undefined;

beforeEach(() => {
  mockStartRun.mockReset();
  // A `DEBUG` in the ambient environment adds a fire-and-forget prompt-history write whose
  // `session.debug.updated` publish lands at an unpredictable point in the trace. Production's
  // default is unset and the debug copy is not part of the turn skeleton, so pin it off.
  restoreDebug = process.env.DEBUG;
  delete process.env.DEBUG;
});

afterEach(() => {
  setOrchestrationRuntime({ bus: restoreBus as never });
  if (restoreDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = restoreDebug;
  vi.restoreAllMocks();
});

async function runTurn(testCase: TurnCase): Promise<Trace> {
  const trace: Trace = [];
  const { channel, sessionName, trackSessionId } = testCase;

  await sessionStore.registerSession(sessionName, {
    sessionId: trackSessionId, channel, backend: 'claude', kind: 'local', projectId: 'general',
    label: 'golden',
  });
  await setSessionAsync(channel, trackSessionId);

  restoreBus = getOrchestrationRuntime().bus;
  setOrchestrationRuntime({ bus: {
    publish: (event: { type: string; role?: string; running?: boolean; backgroundRunning?: boolean }) => {
      if (event.type === 'session.message') {
        trace.push(`session.message(${event.role})`);
        if (event.role === 'user') testCase.onUserMessagePublished?.(channel);
        return;
      }
      if (event.type === 'session.status') {
        trace.push(`session.status(running:${event.running}${event.backgroundRunning ? ',background:true' : ''})`);
        return;
      }
      trace.push(event.type);
    },
    subscribe: () => ({ unsubscribe() {} }),
  } as never });

  // Ledger writes are stubbed rather than exercised: this suite characterizes WHEN the ledger is
  // called relative to everything else, not what it persists (tests/orch/turn-tracking.test.ts
  // owns that). Stubbing also keeps the fresh-session snapshot out of the trace.
  vi.spyOn(conversationLedger, 'initAndBeginTurn').mockImplementation(async () => {
    trace.push('ledger.initAndBeginTurn');
    return { turn: {} as never, turnIndex: 0 };
  });
  vi.spyOn(conversationLedger, 'completeTurn').mockImplementation(async () => {
    trace.push('ledger.completeTurn');
  });

  // Wrap the real lease so its release lands in the trace at the exact point the turn drops it.
  const realAcquire = sessionStore.acquireSessionUse.bind(sessionStore);
  vi.spyOn(sessionStore, 'acquireSessionUse').mockImplementation(async (id: string) => {
    const release = await realAcquire(id);
    if (!release) return null;
    return () => { trace.push('lease.release'); release(); };
  });

  mockStartRun.mockImplementation(() => {
    trace.push('startRun');
    return testCase.run();
  });

  const adapter = new TracingAdapter(trace);
  let queued: Promise<void> | null = null;
  const runner = new AgentRunner({
    tryInject: async () => false,
    track: () => {},
    enqueue: (_channel, fn) => { queued = fn(); return true; },
  });

  await runner.route({
    message: {
      ref: { conduit: channel, messageId: 'M-golden', threadId: null },
      text: 'hello', senderId: 'U-human', isBot: false, files: [],
    } as never,
    channel,
    adapter: adapter as never,
    threadAnchorId: null,
    hasFiles: false,
    userMessage: 'hello',
    agentMessage: 'hello',
  });
  await queued;
  return trace;
}

// --- the four goldens -----------------------------------------------------

test('golden: a successful turn', async () => {
  const trace = await runTurn({
    channel: 'slack:C-golden-ok',
    sessionName: 'cortex-golden-ok',
    trackSessionId: 'track-golden-ok',
    run: () => fakeRun(Promise.resolve(agentResult({ sessionId: 'backend-golden' }))),
  });

  // The turn skeleton, in order. Two facts worth naming because Phase 1 must preserve them:
  //  * the Cancel button (onExecutionStarted) lands AFTER startRun, and the session lease is
  //    dropped one step later (onExecutionRegistered) — not in the finally;
  //  * the terminal seal is written BEFORE `running:false`, which the finally publishes last.
  expect(trace).toEqual([
    'postMessage(status)',
    'ledger.initAndBeginTurn',
    'session.message(user)',
    'session.status(running:true)',
    'startRun',
    'updateMessage(cancel)',
    'lease.release',
    'updateMessage(seal)',
    'ledger.completeTurn',
    'session.status(running:false)',
  ]);
});

test('golden: a rate-limited turn', async () => {
  const trace = await runTurn({
    channel: 'slack:C-golden-rl',
    sessionName: 'cortex-golden-rl',
    trackSessionId: 'track-golden-rl',
    run: () => fakeRun(Promise.resolve(agentResult({ rateLimited: true, rateLimitProvider: 'anthropic' }))),
  });

  // Identical to the success trace up to the terminal render, then it diverges: the rate-limited
  // branch of `handleDefaultAgentResult` seals the status and returns WITHOUT reaching
  // `handleAgentSuccess`, so `ledger.completeTurn` is never called for this turn.
  expect(trace).toEqual([
    'postMessage(status)',
    'ledger.initAndBeginTurn',
    'session.message(user)',
    'session.status(running:true)',
    'startRun',
    'updateMessage(cancel)',
    'lease.release',
    'updateMessage(seal)',
    'session.status(running:false)',
  ]);
});

test('golden: startRun throws', async () => {
  const trace = await runTurn({
    channel: 'slack:C-golden-err',
    sessionName: 'cortex-golden-err',
    trackSessionId: 'track-golden-err',
    run: () => { throw new Error('startRun exploded'); },
  });

  // `startRun` throwing aborts `runConversation` before `onExecutionStarted`, so there is no
  // Cancel update and no registration-time lease release — the lease is dropped by the finally,
  // i.e. AFTER `handleAgentError` has sealed the status and posted the error body.
  expect(trace).toEqual([
    'postMessage(status)',
    'ledger.initAndBeginTurn',
    'session.message(user)',
    'session.status(running:true)',
    'startRun',
    'ledger.completeTurn',
    'updateMessage(seal)',
    'postMessage(text)',
    'lease.release',
    'session.status(running:false)',
  ]);
});

test('golden: superseded while the ledger turn is still pending', async () => {
  const trace = await runTurn({
    channel: 'slack:C-golden-sup',
    sessionName: 'cortex-golden-sup',
    trackSessionId: 'track-golden-sup',
    run: () => fakeRun(Promise.resolve(agentResult())),
    onUserMessagePublished: (channel) => markPendingTurnSuperseded(channel),
  });

  // A turn superseded while its ledger turn was still pending returns from `_executeReal` between
  // `initTurnTracking` and `beginForegroundSession`. That early return is NOT inside the try/finally,
  // so the turn publishes no `running:true`/`running:false` pair at all, never opens a run, and
  // never touches the status message again — the status message posted above is left unsealed.
  expect(trace).toEqual([
    'postMessage(status)',
    'ledger.initAndBeginTurn',
    'session.message(user)',
  ]);
});
