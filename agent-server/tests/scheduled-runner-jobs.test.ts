import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerThreadSession } from '../src/domain/scheduling/jobs/register-thread-session.js';
import { sessionStore } from '../src/store/session-registry-repo.js';

test('sync-public shell script operates on the checkout that contains it', () => {
  const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sync-path-'));
  const capturePath = path.join(root, 'git-cwds.txt');
  const gitPath = path.join(root, 'git');
  fs.writeFileSync(gitPath, `#!/bin/bash
printf '%s\\n' "$PWD" >> "$CAPTURE_PATH"
case "$*" in
  "rev-parse --verify "*) exit 1 ;;
  "rev-parse public/main") printf 'fixture-public-sha\\n' ;;
  "rev-parse --short "*) printf 'fixture-public-sha\\n' ;;
esac
`);
  fs.chmodSync(gitPath, 0o755);

  try {
    const result = spawnSync('bash', [path.join(repoRoot, 'scripts/sync-pull-from-public.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, CAPTURE_PATH: capturePath },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const invokedFrom = fs.readFileSync(capturePath, 'utf8').trim().split('\n');
    assert.ok(invokedFrom.length > 0);
    assert.ok(invokedFrom.every(cwd => cwd === repoRoot));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── registerThreadSession: session registration identity ────────
// The conversation transcript is recorded under the thread step's TRACK sessionId
// (threads/runner.ts). Registering the scheduled session under the backend id instead
// produced ghost records with no transcript — these tests pin the track-id contract.

test('registerThreadSession registers under the LAST step track id with backend resume target + scheduleId', async () => {
  await registerThreadSession('proj-a', {
    sessionName: 'cortex-fin-01',
    result: { sessionId: 'backend-uuid-1' } as any,
    threadResult: {
      thread: { steps: [{ sessionId: 'track-step-1' }, { sessionId: 'track-step-2' }] },
      totalCostUsd: 0.1, totalNumTurns: 3,
    },
    project: 'proj-a', label: 'scan arxiv',
    sessionOrigin: 'scheduled',
    scheduleId: 'sched-42',
  });

  const rec = await sessionStore.getById('track-step-2');
  assert.ok(rec, 'session registered under the last step track id');
  assert.equal(rec!.name, 'cortex-fin-01');
  assert.equal(rec!.kind, 'scheduled');
  assert.equal(rec!.origin, 'scheduled');
  assert.equal(rec!.scheduleId, 'sched-42');
  assert.equal(rec!.backendSessionId, 'backend-uuid-1', 'backend id kept as the resume target');
  assert.equal(rec!.label, 'scan arxiv');
  assert.equal(await sessionStore.getById('backend-uuid-1'), null, 'no ghost record under the backend id');
});

// onEnd hooks (targetAgent mode, e.g. post-task-hook's compound/commit step) inject an EXTRA step
// after the main agent: it records sessionName=null, runs under the backend resume id, and never
// writes a conversation-history transcript. Registering the run under that step's id yields a
// ghost session — the UI opens the run and renders an EMPTY chat while the real transcript sits
// under the main step's track id. Real agent steps always carry a sessionName (minted at step
// start), so registration must key on the last REAL step, not the last recorded step.

test('registerThreadSession skips hook-injected steps when picking the run track id', async () => {
  await registerThreadSession('proj-d', {
    sessionName: 'cortex-fin-04',
    result: { sessionId: 'backend-uuid-4' } as any,
    threadResult: {
      thread: {
        steps: [
          { agentSlotId: 'scheduler-main', sessionId: 'track-main', sessionName: 'cortex-real' },
          // targetAgent-mode hook step: sessionName null, sessionId = backend resume id
          { agentSlotId: 'scheduler-main', sessionId: 'backend-uuid-4', sessionName: null },
          // legacy insertAgent-mode hook step (defensive exclusion)
          { agentSlotId: 'hook:end', sessionId: 'hook-backend-id', sessionName: 'cortex-hook' },
        ],
      },
      totalCostUsd: 0.1, totalNumTurns: 3,
    },
    project: 'proj-d', label: 'scan arxiv',
    sessionOrigin: 'scheduled',
    scheduleId: 'sched-43',
  });

  const rec = await sessionStore.getById('track-main');
  assert.ok(rec, 'session registered under the last REAL agent step track id');
  assert.equal(rec!.name, 'cortex-fin-04');
  assert.equal(rec!.scheduleId, 'sched-43');
  assert.equal(rec!.backendSessionId, 'backend-uuid-4', 'backend id kept as the resume target');
  assert.equal(await sessionStore.getById('backend-uuid-4'), null, 'no ghost record under the hook step id');
  assert.equal(await sessionStore.getById('hook-backend-id'), null, 'no ghost record under a hook: slot id');
});

test('registerThreadSession falls back to result.sessionId when the thread has no steps', async () => {
  await registerThreadSession('proj-b', {
    sessionName: 'cortex-fin-02',
    result: { sessionId: 'backend-uuid-2' } as any,
    threadResult: { totalCostUsd: 0, totalNumTurns: 1 },
    project: 'proj-b', label: null,
    sessionOrigin: 'scheduled',
  });

  const rec = await sessionStore.getById('backend-uuid-2');
  assert.ok(rec, 'stepless run registers under the agent result id (legacy conflated id)');
  assert.equal(rec!.scheduleId, null, 'no scheduleId when the caller passes none');
});

test('registerThreadSession registers nothing without a result session id', async () => {
  await registerThreadSession('proj-c', {
    sessionName: 'cortex-fin-03',
    result: null,
    threadResult: { thread: { steps: [{ sessionId: 'track-orphan' }] } },
    project: 'proj-c', label: null,
    sessionOrigin: 'scheduled',
  });

  assert.equal(await sessionStore.getById('track-orphan'), null, 'no registration without an agent result');
});
