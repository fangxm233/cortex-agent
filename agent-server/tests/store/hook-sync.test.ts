// input:  syncManagedHooks / parseHookVersion (store/hook-sync) over temp src/dst dirs
// output: unit tests — version-stamped managed-hook refresh semantics
// pos:    regression for "deployed hooks go stale": init copies-if-missing, so syncManagedHooks
//         must refresh a deployed hook when the shipped @cortex-hook-version stamp is newer, bring
//         legacy (unstamped) copies under management, and never downgrade or touch unmanaged hooks.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncManagedHooks, parseHookVersion } from '../../src/store/hook-sync.js';

function stamped(version: string, body = 'export const x = 1;'): string {
  return `#!/usr/bin/env node\n// @cortex-hook-version ${version}\n${body}\n`;
}

async function mkdirs(): Promise<{ src: string; dst: string; cleanup: () => Promise<void> }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-sync-'));
  const src = path.join(base, 'defaults-hooks');
  const dst = path.join(base, 'data-hooks');
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(dst, { recursive: true });
  return { src, dst, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

test('parseHookVersion extracts the stamp, or null when absent', () => {
  assert.equal(parseHookVersion('// @cortex-hook-version 2026.6.8\ncode'), '2026.6.8');
  assert.equal(parseHookVersion('// @cortex-hook-version 2026.6.8-2\ncode'), '2026.6.8-2');
  assert.equal(parseHookVersion('no stamp here'), null);
});

test('(a) deploys a managed hook when the destination is missing', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await fs.writeFile(path.join(src, 'h.mjs'), stamped('2026.6.8'));

  const updated = await syncManagedHooks({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, ['h.mjs']);
  assert.ok(existsSync(path.join(dst, 'h.mjs')), 'hook copied to destination');
});

test('(b) refreshes a deployed hook when the shipped version is newer', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await fs.writeFile(path.join(src, 'h.mjs'), stamped('2026.6.8', 'export const NEW = 1;'));
  await fs.writeFile(path.join(dst, 'h.mjs'), stamped('2026.5.9', 'export const OLD = 1;'));

  const updated = await syncManagedHooks({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, ['h.mjs']);
  assert.ok((await fs.readFile(path.join(dst, 'h.mjs'), 'utf8')).includes('NEW'), 'destination now has new code');
});

test('(c) brings a legacy UNstamped deployed hook under management (counts as oldest)', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await fs.writeFile(path.join(src, 'h.mjs'), stamped('2026.6.8', 'export const NEW = 1;'));
  await fs.writeFile(path.join(dst, 'h.mjs'), '#!/usr/bin/env node\nexport const LEGACY = 1;\n'); // no stamp

  const updated = await syncManagedHooks({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, ['h.mjs']);
  assert.ok((await fs.readFile(path.join(dst, 'h.mjs'), 'utf8')).includes('NEW'), 'legacy copy refreshed');
});

test('(d) leaves a current deployed hook untouched (same version → no write)', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await fs.writeFile(path.join(src, 'h.mjs'), stamped('2026.6.8', 'export const SHIPPED = 1;'));
  await fs.writeFile(path.join(dst, 'h.mjs'), stamped('2026.6.8', 'export const LOCAL = 1;'));

  const updated = await syncManagedHooks({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, [], 'no update when versions match');
  assert.ok((await fs.readFile(path.join(dst, 'h.mjs'), 'utf8')).includes('LOCAL'), 'existing content preserved');
});

test('(e) never downgrades when the deployed hook is newer than the shipped default', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await fs.writeFile(path.join(src, 'h.mjs'), stamped('2026.5.9'));
  await fs.writeFile(path.join(dst, 'h.mjs'), stamped('2026.6.8', 'export const NEWER = 1;'));

  const updated = await syncManagedHooks({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, [], 'no downgrade');
  assert.ok((await fs.readFile(path.join(dst, 'h.mjs'), 'utf8')).includes('NEWER'), 'newer deployed copy kept');
});

test('(f) ignores unmanaged (unstamped) defaults — left to init copy-if-missing', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await fs.writeFile(path.join(src, 'h.mjs'), '#!/usr/bin/env node\nexport const UNMANAGED = 1;\n'); // no stamp

  const updated = await syncManagedHooks({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, [], 'unmanaged default not synced');
  assert.ok(!existsSync(path.join(dst, 'h.mjs')), 'unmanaged default not deployed by sync');
});
