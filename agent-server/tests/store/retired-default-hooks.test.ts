import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { removeRetiredDefaultHooks } from '../../src/store/version-migrations.js';

async function setup(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retired-hooks-'));
  t.onTestFinished(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, 'config', 'hooks'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'hooks'), { recursive: true });
  return dataDir;
}

function entryPath(dataDir: string, file: string): string {
  return path.join(dataDir, 'config', 'hooks', file);
}

function scriptPath(dataDir: string, file: string): string {
  return path.join(dataDir, 'hooks', file);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

const SHIPPED_ASK = {
  id: 'ask-user-question-hook',
  event: 'agent:pre-tool',
  matcher: 'AskUserQuestion',
  run: { script: 'ask-user-question-hook.mjs', timeout: 3600 },
  enabled: true,
};
const SHIPPED_PLAN = {
  id: 'exit-plan-mode-hook',
  event: 'agent:pre-tool',
  matcher: 'ExitPlanMode',
  run: { script: 'exit-plan-mode-hook.mjs', timeout: 3600 },
  enabled: true,
};

const SHIPPED_PERMISSION = {
  id: 'permission-request-auto-allow',
  event: 'cc:PermissionRequest',
  matcher: 'Edit|Write',
  run: { command: "printf '{}'", timeout: 5 },
  enabled: true,
};

test('removes every shipped retired entry, plus the scripts that belong to one', async (t) => {
  const dataDir = await setup(t);
  await fs.writeFile(entryPath(dataDir, '03-ask-user-question-hook.json'), JSON.stringify(SHIPPED_ASK));
  await fs.writeFile(entryPath(dataDir, '04-exit-plan-mode-hook.json'), JSON.stringify(SHIPPED_PLAN));
  await fs.writeFile(entryPath(dataDir, '09-permission-request-auto-allow.json'), JSON.stringify(SHIPPED_PERMISSION));
  await fs.writeFile(scriptPath(dataDir, 'ask-user-question-hook.mjs'), '// retired\n');
  await fs.writeFile(scriptPath(dataDir, 'exit-plan-mode-hook.mjs'), '// retired\n');
  // A live hook sharing the directory must survive.
  await fs.writeFile(entryPath(dataDir, '05-memory-ref-tracker.json'), JSON.stringify({ id: 'memory-ref-tracker' }));

  await removeRetiredDefaultHooks(dataDir);

  assert.equal(await exists(entryPath(dataDir, '03-ask-user-question-hook.json')), false);
  assert.equal(await exists(entryPath(dataDir, '04-exit-plan-mode-hook.json')), false);
  assert.equal(await exists(scriptPath(dataDir, 'ask-user-question-hook.mjs')), false);
  assert.equal(await exists(scriptPath(dataDir, 'exit-plan-mode-hook.mjs')), false);
  // The auto-allow entry ran an inline command, so there is no script to chase.
  assert.equal(await exists(entryPath(dataDir, '09-permission-request-auto-allow.json')), false);
  assert.equal(await exists(entryPath(dataDir, '05-memory-ref-tracker.json')), true);
});

test('leaves a repurposed file under the same name alone', async (t) => {
  const dataDir = await setup(t);
  const repurposed = { id: 'my-own-hook', event: 'agent:pre-tool', run: { command: 'mine' } };
  await fs.writeFile(entryPath(dataDir, '03-ask-user-question-hook.json'), JSON.stringify(repurposed));
  await fs.writeFile(scriptPath(dataDir, 'ask-user-question-hook.mjs'), '// mine\n');

  await removeRetiredDefaultHooks(dataDir);

  assert.equal(await exists(entryPath(dataDir, '03-ask-user-question-hook.json')), true);
  assert.equal(await exists(scriptPath(dataDir, 'ask-user-question-hook.mjs')), true);
});

test('is a no-op on an install that never had them', async (t) => {
  const dataDir = await setup(t);
  await removeRetiredDefaultHooks(dataDir);
  await removeRetiredDefaultHooks(dataDir);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'config', 'hooks')), []);
});
