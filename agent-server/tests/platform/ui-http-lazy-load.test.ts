// input:  the CORTEX_UI_HTTP gate (entry/ui-http-gate.ts) + the wiring (entry/start-ui-http.ts)
// output: runtime guard — with CORTEX_UI_HTTP unset, loading + invoking the gate must NOT pull
//         @trpc/server or jose into the module graph (they stay runtime-lazy for Slack/TUI-only
//         installs). Replaces the old package.json-shape guard (no-trpc-dep.test.ts), which is void
//         now that @trpc/server + jose are legitimate core dependencies (single-package merge).
// pos:    Regression guard for the §11 single-package reversal. A child process registers a resolve
//         hook (ui-http-lazy-hooks.mjs) that records every resolved specifier; the driver
//         (ui-http-lazy-driver.mjs) runs the gate flag-off and prints the recorded specifiers. The
//         positive control (LAZY_MODE=load) proves the hook records trpc/jose when they DO load.
// >>> If I am updated, update tests/CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const driver = path.join(here, 'ui-http-lazy-driver.mjs');
const agentDir = path.resolve(here, '..', '..'); // agent-server/

/** Run the driver in a given LAZY_MODE and return the recorded resolved specifiers. */
function recordResolves(mode: 'off' | 'load'): string[] {
  const res = spawnSync(process.execPath, ['--import', 'tsx', driver], {
    cwd: agentDir,
    env: { ...process.env, LAZY_MODE: mode, CORTEX_UI_HTTP: '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(res.status, 0, `driver (${mode}) exit ${res.status}\nstderr:\n${res.stderr}`);
  const lastLine = res.stdout.trim().split('\n').filter(Boolean).pop() ?? '[]';
  return JSON.parse(lastLine) as string[];
}

test('flag off: loading + invoking the gate does NOT eager-load @trpc/server or jose', () => {
  const seen = recordResolves('off');
  const trpc = seen.filter((s) => s === '@trpc/server' || s.startsWith('@trpc/server/'));
  const jose = seen.filter((s) => s === 'jose' || s.startsWith('jose/'));
  assert.deepEqual(trpc, [], `@trpc/server must stay unloaded when CORTEX_UI_HTTP is off; saw: ${trpc}`);
  assert.deepEqual(jose, [], `jose must stay unloaded when CORTEX_UI_HTTP is off; saw: ${jose}`);
});

test('positive control: loading the transport DOES resolve @trpc/server + jose (hook sanity)', () => {
  const seen = recordResolves('load');
  assert.ok(
    seen.some((s) => s === '@trpc/server' || s.startsWith('@trpc/server/')),
    'the resolve hook must record @trpc/server when the transport is actually loaded',
  );
  assert.ok(
    seen.some((s) => s === 'jose' || s.startsWith('jose/')),
    'the resolve hook must record jose when the transport is actually loaded',
  );
});
