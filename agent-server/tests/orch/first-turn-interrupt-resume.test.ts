// The subject moved, not the subject matter: `runConversation` is gone and its run-opening half —
// the resume-target sink, the execution callbacks, awaiting the result — is now `Turn.run()`. These
// tests therefore drive `openTurn` with `prepareConversationRequest` as its `prepareRequest`, which
// is exactly what `agent-runner._executeReal` does. Two consequences for the driving code (the
// assertions are unchanged):
//   * a Turn RENDERS a failed turn instead of rethrowing it, so `rejects.toMatchObject({cancelled})`
//     becomes "the turn finished and sealed its status message";
//   * a Turn posts its status message and resolves ids before it opens the run, so the live-registry
//     test holds the attempt open instead of reading after a single microtask.
import { test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockStartAttempt } = vi.hoisted(() => ({
  mockStartAttempt: vi.fn<(input: StartAttemptInput) => RunAttempt>(),
}));

// `startRun` opens the attempt chain through `startAttempt`; mocking that one entry point returns a
// synthetic `RunAttempt` so this orchestration suite observes the request/config the run assembles
// without ever spawning a backend. (The facade this used to intercept is gone.)
vi.mock('@domain/runs/attempt.js', () => ({
  startAttempt: (...args: unknown[]) => mockStartAttempt(...args as [StartAttemptInput]),
}));

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getDefaultAgent: () => 'main',
    getActiveProfile: () => 'default',
    getClaudeMode: () => 'api',
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

import type { RunAttempt, StartAttemptInput } from '../../src/domain/runs/attempt.js';
import type { DownloadedFile } from '../../src/platform/types.js';
import { openTurn } from '../../src/orchestration/turn/turn.js';
import { prepareConversationRequest } from '../../src/orchestration/conversation-request.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { cancelChannelRuns } from '../../src/orchestration/routing/commands/cancel.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { getSessionAsync, setSessionAsync } from '../../src/domain/sessions/session.js';
import { resolveRunBackend } from '../../src/domain/runs/config-resolver.js';
import { runRegistry } from '../../src/core/run-registry.js';

/** The synthetic attempt shape `startAttempt` hands the run; only the fields the run reads. */
function makeSyntheticAttempt(opts: {
  backendSessionId: string | null;
  foreground: Promise<unknown>;
  backend?: string;
}): RunAttempt {
  return {
    engine: {} as any,
    engineRun: {} as any,
    spec: {} as any,
    backend: (opts.backend ?? 'claude') as any,
    identity: null,
    foreground: opts.foreground as Promise<any>,
    settled: opts.foreground as Promise<any>,
    backendSessionId: opts.backendSessionId,
    kill: () => true,
  };
}

function makeCancelledAttempt(backendSessionId: string): RunAttempt {
  const err = Object.assign(new Error('Cancelled'), { cancelled: true });
  const promise = Promise.reject(err);
  promise.catch(() => {}); // avoid unhandled-rejection noise before the test awaits it
  return makeSyntheticAttempt({ backendSessionId, foreground: promise });
}

/** One plain conversation turn, driven the way `agent-runner._executeReal` drives it. `ledger: null`
 *  keeps the conversation ledger out of these traces — this file is about the resume target and the
 *  assembled request, both of which the ledger has no part in. */
function runTurn(opts: {
  trackSessionId: string;
  backendSessionId: string | null;
  sessionName: string;
  files?: DownloadedFile[];
  onPromptBuilt?: (prompt: string) => void;
}): { done: Promise<void>; adapter: MockAdapter } {
  const channel = 'slack:C-interrupt';
  const adapter = new MockAdapter();
  const done = openTurn({
    channel,
    adapter: adapter as any,
    threadAnchorId: null,
    session: {
      sessionId: opts.trackSessionId,
      sessionName: opts.sessionName,
      backendSessionId: opts.backendSessionId,
      projectId: 'general',
      lease: null,
    },
    user: { text: 'hello' },
    ledger: null,
    trigger: 'user',
    prepareRequest: (ids) => prepareConversationRequest({
      ids: {
        sessionId: ids.sessionId ?? '',
        backendSessionId: ids.backendSessionId,
        sessionName: ids.sessionName ?? '',
        projectId: ids.projectId,
      },
      channel,
      userMessage: 'hello',
      files: opts.files ?? [],
      trigger: 'user',
      onPromptBuilt: opts.onPromptBuilt ?? null,
    }),
  });
  return { done, adapter };
}

/** The turn ended by rendering its failure: the status message was posted and then sealed. */
function assertSealedTurn(adapter: MockAdapter): void {
  assert.equal(adapter.posted.length >= 1, true, 'the turn posted a status message');
  assert.equal(adapter.updated.length >= 1, true, 'the turn sealed its status message');
}

// ── (1) a turn persists the backend resume target on settle ────────────────

test('first-turn kill persists the spawn-time backend session id (resume works on the next message)', async () => {
  await sessionStore.registerSession('cortex-int1', {
    sessionId: 'TRACK-1', channel: 'slack:C-interrupt', backend: 'claude', kind: 'local',
  });
  mockStartAttempt.mockReturnValueOnce(makeCancelledAttempt('B-claude-1'));

  const turn = runTurn({
    trackSessionId: 'TRACK-1',
    backendSessionId: null, // fresh session — first turn
    sessionName: 'cortex-int1',
  });
  await turn.done;
  assertSealedTurn(turn.adapter);

  const rec = await sessionStore.getById('TRACK-1');
  assert.equal(rec?.backendSessionId, 'B-claude-1');
});

test('a turn exposes the exact assembled prompt passed to the agent', async () => {
  let capturedPrompt: string | null = null;
  mockStartAttempt.mockReturnValueOnce(makeCancelledAttempt('B-prompt'));

  await runTurn({
    trackSessionId: 'TRACK-PROMPT',
    backendSessionId: 'B-existing',
    sessionName: 'cortex-prompt',
    onPromptBuilt: (prompt: string) => { capturedPrompt = prompt; },
  }).done;

  assert.equal(
    capturedPrompt,
    mockStartAttempt.mock.calls.at(-1)?.[0]?.request.prompt.text,
    'capture sees byte-for-byte adapter input',
  );
  assert.equal(capturedPrompt, 'hello', 'resumed direct turns send the user text without fresh-session context');
});

test('a turn\'s DEBUG prompt includes the image path sent through the adapter', async () => {
  let capturedPrompt: string | null = null;
  mockStartAttempt.mockReturnValueOnce(makeCancelledAttempt('B-image-prompt'));

  await runTurn({
    trackSessionId: 'TRACK-IMAGE-PROMPT',
    backendSessionId: 'B-existing',
    sessionName: 'cortex-image-prompt',
    files: [{ localPath: '/tmp/cortex-image.png', mimetype: 'image/png', name: 'cortex-image.png' }],
    onPromptBuilt: (prompt: string) => { capturedPrompt = prompt; },
  }).done;

  assert.equal(
    capturedPrompt,
    '[User sent 1 image(s). Read these files to view them:\n/tmp/cortex-image.png\n]\n\nhello',
  );
});

test('interrupt on a RESUMED turn leaves the stored backend session id untouched', async () => {
  await sessionStore.registerSession('cortex-int2', {
    sessionId: 'TRACK-2', channel: 'slack:C-interrupt', backend: 'claude', kind: 'local',
    backendSessionId: 'B-old',
  });
  mockStartAttempt.mockReturnValueOnce(makeCancelledAttempt('B-old'));

  const turn = runTurn({
    trackSessionId: 'TRACK-2',
    backendSessionId: 'B-old', // resumed session
    sessionName: 'cortex-int2',
  });
  await turn.done;
  assertSealedTurn(turn.adapter);

  const rec = await sessionStore.getById('TRACK-2');
  assert.equal(rec?.backendSessionId, 'B-old');
});

// ── (2) cancelLive must not rebind the channel to the backend id ────────────

test('cancelChannelRuns keeps the channel bound to the stable track id', async () => {
  const backend = resolveRunBackend({ channel: 'slack:C-keep' });
  await setSessionAsync('slack:C-keep', 'TRACK-3', backend);
  runRegistry.register({
    threadId: null,
    channel: 'slack:C-keep',
    agentSlotId: null,
    executionId: null,
    registryKey: 'rk-cancel-test',
    kind: 'local',
    kill: () => true,
    backend,
    backendSessionId: 'B-backend-uuid', // spawn-time BACKEND id snapshot — must NOT become the binding
  });

  const n = await cancelChannelRuns('slack:C-keep');
  assert.equal(n, 1);
  assert.equal(await getSessionAsync('slack:C-keep', backend), 'TRACK-3');
});

test('a turn registers both track and backend ids on the live execution handle', async () => {
  const held = heldAttempt('B-live-1');
  mockStartAttempt.mockReturnValueOnce(held.attempt);
  const before = new Set(runRegistry.getAll().map((entry) => entry.registryKey));
  const turn = runTurn({
    trackSessionId: 'TRACK-LIVE',
    backendSessionId: 'B-prev',
    sessionName: 'cortex-live',
  });
  // The attempt is held open, so the entry is still live while it is inspected — the Turn posts a
  // status message before it opens the run, so a single microtask is no longer enough to see it.
  const live = await awaitNewRegistryEntry(before);
  assert.equal(live?.trackSessionId, 'TRACK-LIVE');
  assert.equal(live?.backendSessionId, 'B-live-1');
  held.fail();
  await turn.done;
});

// ── (3) the resume target reaches disk MID-turn, not only on settle ─────────
//
// A turn that errors settles the run, so the settle-time write above covers it. A process that dies
// mid-turn settles nothing — the pointer has to be on disk before then, or the first turn's
// transcript is orphaned (nothing maps a track id to Claude's spawn-time UUID).

/** A turn held open by the test: the run is live until `fail()` ends it. */
function heldAttempt(backendSessionId: string | null) {
  let fail!: () => void;
  const promise = new Promise<never>((_resolve, reject) => {
    fail = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
  });
  promise.catch(() => {}); // the run attaches its own handlers; keep the node warning away
  return { attempt: makeSyntheticAttempt({ backendSessionId, foreground: promise }), fail };
}

/** A turn resolves its status message, profile, project and prompt before it opens the attempt. */
async function awaitAttemptStart(read: () => ((event: any) => void) | null, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const emit = read();
    if (emit) return emit;
    if (Date.now() > deadline) throw new Error('the run never opened its attempt');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Poll the live registry: the Turn opens the run several awaits in, not on the next microtask. */
async function awaitNewRegistryEntry(before: Set<string>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const live = runRegistry.getAll().find((entry) => !before.has(entry.registryKey));
    if (live) return live;
    if (Date.now() > deadline) throw new Error('the turn never registered a live run');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Poll the record rather than counting ticks: the write crosses the store's own async queue. */
async function awaitStoredBackendId(trackSessionId: string, timeoutMs = 2000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = await sessionStore.getById(trackSessionId);
    if (rec?.backendSessionId) return rec.backendSessionId;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('claude: the spawn-time backend id is stored while the first turn is still running', async () => {
  await sessionStore.registerSession('cortex-mid1', {
    sessionId: 'TRACK-MID1', channel: 'slack:C-interrupt', backend: 'claude', kind: 'local',
  });
  const held = heldAttempt('B-mid-claude');
  mockStartAttempt.mockReturnValueOnce(held.attempt);

  const turn = runTurn({
    trackSessionId: 'TRACK-MID1',
    backendSessionId: null, // fresh session — first turn
    sessionName: 'cortex-mid1',
  });

  assert.equal(await awaitStoredBackendId('TRACK-MID1'), 'B-mid-claude', 'stored before the turn settles');

  held.fail();
  await turn.done;
});

test('pi: the id announced by engine_started is stored while the first turn is still running', async () => {
  await sessionStore.registerSession('cortex-mid2', {
    sessionId: 'TRACK-MID2', channel: 'slack:C-interrupt', backend: 'pi', kind: 'local',
  });
  // PI names itself a tick after the attempt opens — `backendSessionId` is null at registration.
  const held = heldAttempt(null);
  let emit: ((event: any) => void) | null = null;
  mockStartAttempt.mockImplementationOnce((input: StartAttemptInput) => {
    emit = input.onEvent;
    return held.attempt;
  });

  const turn = runTurn({
    trackSessionId: 'TRACK-MID2',
    backendSessionId: null,
    sessionName: 'cortex-mid2',
  });
  (await awaitAttemptStart(() => emit))({ type: 'engine_started', backendSessionId: 'B-mid-pi' });

  assert.equal(await awaitStoredBackendId('TRACK-MID2'), 'B-mid-pi', 'stored before the turn settles');

  held.fail();
  await turn.done;
});

test('a backend that resets the session mid-turn leaves the NEW id as the resume target', async () => {
  await sessionStore.registerSession('cortex-mid3', {
    sessionId: 'TRACK-MID3', channel: 'slack:C-interrupt', backend: 'claude', kind: 'local',
    backendSessionId: 'B-gone',
  });
  const held = heldAttempt('B-gone');
  let emit: ((event: any) => void) | null = null;
  mockStartAttempt.mockImplementationOnce((input: StartAttemptInput) => {
    emit = input.onEvent;
    return held.attempt;
  });

  const turn = runTurn({
    trackSessionId: 'TRACK-MID3',
    backendSessionId: 'B-gone', // asked to resume a transcript the backend no longer has
    sessionName: 'cortex-mid3',
  });
  (await awaitAttemptStart(() => emit))({ type: 'engine_started', backendSessionId: 'B-restarted' });

  held.fail();
  await turn.done;

  const rec = await sessionStore.getById('TRACK-MID3');
  assert.equal(rec?.backendSessionId, 'B-restarted', 'the next turn must resume where this one ended');
});
