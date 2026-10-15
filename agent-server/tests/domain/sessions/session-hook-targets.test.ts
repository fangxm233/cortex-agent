// Session hooks address a session by two different ids, and must not swap them. The Cortex track
// id is what the registry is keyed by and what a hook script sees as `sessionId`; the backend id is
// what an injected turn resumes. They differ for any session whose backend id was assigned by the
// backend (Slack, Feishu, the Web after a first turn) or moved by a rewind.
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const { started } = vi.hoisted(() => ({
  started: [] as Array<import('../../../src/domain/runs/request.js').RunRequest>,
}));

vi.mock('../../../src/domain/runs/service.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    startRun: (request: import('../../../src/domain/runs/request.js').RunRequest) => {
      started.push(request);
      return { executionId: 'exec-hook', result: Promise.resolve({ sessionId: 'unused' }) };
    },
  };
});

import { CONFIG_DIR, HOOKS_DIR } from '../../../src/core/paths.js';
import * as hookBus from '../../../src/core/hook-bus.js';
import { loadHookRegistry, type HookEntry, type HookEvent } from '../../../src/store/hook-registry.js';
import { sessionStore } from '../../../src/store/session-registry-repo.js';
import { fireAndForgetPreCloseHook } from '../../../src/domain/sessions/session-hooks.js';
import { handleDefaultAgentResult } from '../../../src/orchestration/turn/terminal.js';
import { MockAdapter, MockOutputStream } from '../../../src/platform/testing.js';
import { runRequestFixture } from '../../run-request-fixture.js';
import { setChannelSelection } from '../../../src/domain/agents/config.js';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
const selection: EngineSelection = { backend: 'claude', provider: null, model: 'session-model', thinking: 'high', mode: 'session-route' };

const CAPTURE = path.join(HOOKS_DIR, 'hook-payload.json');
const CAPTURE_SCRIPT = [
  "import { writeFileSync } from 'node:fs';",
  "let input = '';",
  "process.stdin.on('data', (chunk) => { input += chunk; });",
  "process.stdin.on('end', () => {",
  '  writeFileSync(' + JSON.stringify(CAPTURE) + ', JSON.stringify({',
  '    payload: JSON.parse(input),',
  '    sessionEnv: process.env.CORTEX_HOOK_SESSION_ID,',
  '    backendEnv: process.env.CORTEX_HOOK_BACKEND_SESSION_ID ?? null,',
  '  }));',
  "  process.stdout.write('recall');",
  '});',
].join('\n');

let seq = 0;
function freshSession() {
  seq += 1;
  return {
    channel: `slack:C-hooks-${seq}`,
    trackId: `track-${seq}`, backendId: `backend-${seq}`,
  };
}

async function register(s: ReturnType<typeof freshSession>, backendSessionId: string | null): Promise<void> {
  await sessionStore.registerSession({
    sessionId: s.trackId, backendSessionId, channel: s.channel, backend: 'claude', kind: 'local',
    selection,
  });
  await sessionStore.bindChannel(s.channel, s.trackId);
  setChannelSelection(s.channel, { ...selection, model: 'wrong-channel-model', thinking: 'low', mode: 'wrong-route' });
}

function writeHooks(entries: HookEntry[]): void {
  const registryDir = path.join(CONFIG_DIR, 'hooks');
  rmSync(registryDir, { recursive: true, force: true });
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(HOOKS_DIR, { recursive: true });
  entries.forEach((entry, index) => {
    writeFileSync(path.join(registryDir, `${String(index + 1).padStart(2, '0')}-${entry.id}.json`), JSON.stringify(entry));
  });
  writeFileSync(path.join(HOOKS_DIR, 'capture.mjs'), CAPTURE_SCRIPT);
  hookBus.initHookBus({
    entries: loadHookRegistry({ user: registryDir, builtin: null }),
    scriptDirs: { user: HOOKS_DIR, builtin: null },
  });
}

function hook(event: HookEvent, run: HookEntry['run']): HookEntry {
  return { id: event.replace(/\W/g, '-'), event, run: { ...run, timeout: 5 }, result: 'stdout-as-prompt' };
}

function finishTurn(s: ReturnType<typeof freshSession>, request: ReturnType<typeof runRequestFixture> | null) {
  const adapter = new MockAdapter();
  const stream = new MockOutputStream(adapter, { type: 'interactive-reply', conduit: s.channel, sessionId: s.trackId });
  return handleDefaultAgentResult({
    result: { sessionId: s.backendId, total_cost_usd: 0, num_turns: 1, rateLimited: false, finalOutput: 'ok' } as any,
    channel: s.channel, adapter, statusMsg: { conduit: s.channel, messageId: 'status' },
    startTime: Date.now(), userMessage: 'hi', executionId: 'exec-1', sessionId: s.trackId, threadAnchorId: null, messageTs: null,
    callbacks: { onAssistantMsg: Object.assign(() => {}, { stream }) },
    request,
  });
}

beforeAll(() => {});
beforeEach(() => {
  started.length = 0;
  rmSync(CAPTURE, { force: true });
});

test('the onNew follow-up turn resumes the session\'s backend id, not its track id', async () => {
  const s = freshSession();
  await register(s, s.backendId);
  writeHooks([hook('cortex:session.new', { command: "node -e 'process.stdout.write(\"recall\")'" })]);
  await fireAndForgetPreCloseHook(s.channel, new MockAdapter());
  await vi.waitFor(() => expect(started).toHaveLength(1));
  expect(started[0].session.sessionId).toBe(s.trackId);
  expect(started[0].session.backendSessionId).toBe(s.backendId);
  expect(started[0].selection).toEqual(selection);
});

test('a session with no backend conversation yet runs the onNew hook but injects nothing', async () => {
  const s = freshSession();
  await register(s, null);
  writeHooks([hook('cortex:session.new', { script: 'capture.mjs' })]);
  await fireAndForgetPreCloseHook(s.channel, new MockAdapter());
  await vi.waitFor(() => expect(readFileSync(CAPTURE, 'utf8')).toContain(s.trackId));
  expect(started).toHaveLength(0);
});

test('onMessageEnd hands the hook the track id, the registry selection and the backend id', async () => {
  const s = freshSession();
  await register(s, s.backendId);
  writeHooks([hook('cortex:session.messageEnd', { script: 'capture.mjs' })]);
  await finishTurn(s, null);
  const seen = JSON.parse(readFileSync(CAPTURE, 'utf8'));
  expect(seen.payload.sessionId).toBe(s.trackId);
  expect(seen.payload.backendSessionId).toBe(s.backendId);
  expect(seen.payload.backend).toBe(selection.backend);
  expect(seen.payload.model).toBe(selection.model);
  expect(seen.payload).not.toHaveProperty('profile');
  expect(seen.sessionEnv).toBe(s.trackId);
  expect(seen.backendEnv).toBe(s.backendId);
});

test('the onMessageEnd follow-up continues the finished turn\'s session and resumes its backend id', async () => {
  const s = freshSession();
  await register(s, null);
  writeHooks([hook('cortex:session.messageEnd', { command: "node -e 'process.stdout.write(\"follow up\")'" })]);
  // A first turn: it opened with no backend id and the backend assigned one.
  const request = runRequestFixture({ channel: s.channel, trackSessionId: s.trackId});
  await finishTurn(s, request);
  expect(started).toHaveLength(1);
  expect(started[0].session.sessionId).toBe(s.trackId);
  expect(started[0].session.backendSessionId).toBe(s.backendId);
  expect(started[0].prompt.text).toBe('follow up');
});
