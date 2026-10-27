import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';

const hook = path.resolve(import.meta.dirname, '../../scripts/postinstall-restart-trigger.mjs');
const roots: string[] = [];

function runHook(skip: string | undefined, initialized = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-hook-test-'));
  roots.push(home);
  if (initialized) fs.mkdirSync(path.join(home, 'data'));
  const env = { ...process.env, CORTEX_HOME: home };
  delete env.CORTEX_SKIP_POSTINSTALL_RESTART;
  if (skip !== undefined) env.CORTEX_SKIP_POSTINSTALL_RESTART = skip;
  const output = execFileSync(process.execPath, [hook], { env, encoding: 'utf8' });
  return { home, output, trigger: path.join(home, 'data/.restart'), env };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('daemon-managed installs suppress the restart trigger', () => {
  const { trigger, output } = runHook('1');
  assert.equal(fs.existsSync(trigger), false);
  assert.equal(output, '');
});

test('suppression does not touch an existing external restart request', () => {
  const { trigger, env } = runHook(undefined);
  fs.writeFileSync(trigger, 'external request');
  fs.utimesSync(trigger, 1, 1);
  execFileSync(process.execPath, [hook], { env: { ...env, CORTEX_SKIP_POSTINSTALL_RESTART: '1' } });
  assert.equal(fs.readFileSync(trigger, 'utf8'), 'external request');
  assert.equal(fs.statSync(trigger).mtimeMs, 1000);
});

test.each([undefined, '0', 'true'])('ordinary external upgrade still touches trigger (skip=%s)', skip => {
  const { trigger, output } = runHook(skip);
  assert.ok(fs.existsSync(trigger));
  assert.match(output, /Wrote restart trigger/);
});

test('fresh installs remain a no-op without an initialized data directory', () => {
  const { home, trigger } = runHook(undefined, false);
  assert.equal(fs.existsSync(trigger), false);
  assert.deepEqual(fs.readdirSync(home), []);
});
