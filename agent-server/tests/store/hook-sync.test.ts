// input:  hook-sync APIs over temporary script and registry dirs
// output: managed script and JSON registry synchronization tests
// pos:    Regression coverage for versioned hook asset deployment
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseHookVersion,
  syncManagedHookEntries,
  syncManagedHooks,
} from '../../src/store/hook-sync.js';

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

function registryEntry(id: string, version?: string): Record<string, unknown> {
  return {
    id,
    event: 'agent:pre-tool',
    matcher: 'Edit|Write',
    run: { script: `${id}.mjs`, timeout: 10 },
    enabled: true,
    ...(version ? { version } : {}),
  };
}

async function writeJson(directory: string, filename: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(directory, filename), `${JSON.stringify(value, null, 2)}\n`);
}

test('registry sync copies and upgrades with the original shipped bytes', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  const missingBytes = `${JSON.stringify(registryEntry('missing', '2026.7.29'), null, 4)}\n\n`;
  const upgradeBytes = `${JSON.stringify(registryEntry('upgrade', '2026.7.29-2'))}\n`;
  await fs.writeFile(path.join(src, 'missing.json'), missingBytes);
  await fs.writeFile(path.join(src, 'upgrade.json'), upgradeBytes);
  await writeJson(dst, 'upgrade.json', { ...registryEntry('upgrade', '2026.7.29'), local: true });

  const updated = await syncManagedHookEntries({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, ['missing.json', 'upgrade.json']);
  assert.equal(await fs.readFile(path.join(dst, 'missing.json'), 'utf8'), missingBytes);
  assert.equal(await fs.readFile(path.join(dst, 'upgrade.json'), 'utf8'), upgradeBytes);
});

test('registry sync never overwrites entries without a valid managed version', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  const destinations: Record<string, string> = {
    'versionless.json': JSON.stringify(registryEntry('versionless')),
    'malformed.json': '{bad json',
    'array.json': '[]',
    'invalid-version.json': JSON.stringify({ ...registryEntry('invalid-version'), version: 'latest' }),
  };
  for (const [file, content] of Object.entries(destinations)) {
    const id = file.replace('.json', '');
    await writeJson(src, file, registryEntry(id, '2026.7.29'));
    await fs.writeFile(path.join(dst, file), content);
  }
  const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  t.onTestFinished(() => info.mockRestore());

  const updated = await syncManagedHookEntries({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, []);
  for (const [file, content] of Object.entries(destinations)) {
    assert.equal(await fs.readFile(path.join(dst, file), 'utf8'), content);
  }
  assert.doesNotMatch(info.mock.calls.flat().join('\n'), /managed hook entries up to date/);
});

test('registry sync preserves same/newer entries and rejects invalid shipped entries', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await writeJson(src, 'same.json', registryEntry('same', '2026.7.29-2'));
  await writeJson(dst, 'same.json', { ...registryEntry('same', '2026.7.29-2'), local: true });
  await writeJson(src, 'newer.json', registryEntry('newer', '2026.7.29-2'));
  await writeJson(dst, 'newer.json', { ...registryEntry('newer', '2026.7.29-3'), local: true });
  await writeJson(src, 'unmanaged.json', registryEntry('unmanaged'));
  await writeJson(src, 'invalid.json', { id: 'invalid', event: 'unknown:event', version: '2026.7.29' });
  await fs.writeFile(path.join(src, 'malformed.json'), '{bad json');
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());
  t.onTestFinished(() => info.mockRestore());

  const updated = await syncManagedHookEntries({ srcDir: src, dstDir: dst });

  assert.deepEqual(updated, []);
  assert.equal(JSON.parse(await fs.readFile(path.join(dst, 'same.json'), 'utf8')).local, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(dst, 'newer.json'), 'utf8')).local, true);
  assert.ok(!existsSync(path.join(dst, 'unmanaged.json')));
  assert.ok(!existsSync(path.join(dst, 'invalid.json')));
  assert.ok(!existsSync(path.join(dst, 'malformed.json')));
  assert.match(error.mock.calls.flat().join('\n'), /malformed\.json/);
  assert.doesNotMatch(info.mock.calls.flat().join('\n'), /managed hook entries up to date/);
});

test('registry sync logs a source-directory discovery failure', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  await fs.rm(src, { recursive: true });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(await syncManagedHookEntries({ srcDir: src, dstDir: dst }), []);
  const errors = error.mock.calls.flat().join('\n');
  assert.match(errors, new RegExp(src));
  assert.match(errors, /ENOENT/);
});

test('registry sync reports file read failures without claiming it is current', async (t) => {
  const { src, dst, cleanup } = await mkdirs();
  t.onTestFinished(cleanup);
  const sourcePath = path.join(src, 'bad-source.json');
  const destinationPath = path.join(dst, 'bad-destination.json');
  await fs.mkdir(sourcePath);
  await writeJson(src, 'bad-destination.json', registryEntry('bad-destination', '2026.7.29'));
  await fs.mkdir(destinationPath);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());
  t.onTestFinished(() => info.mockRestore());

  assert.deepEqual(await syncManagedHookEntries({ srcDir: src, dstDir: dst }), []);
  const errors = error.mock.calls.flat().join('\n');
  assert.ok(errors.includes(sourcePath));
  assert.ok(errors.includes(destinationPath));
  assert.match(errors, /EISDIR|illegal operation on a directory/i);
  assert.doesNotMatch(info.mock.calls.flat().join('\n'), /managed hook entries up to date/);
});

test('startup wrapper syncs scripts and registry entries in one call', async (t) => {
  const scripts = await mkdirs();
  const entries = await mkdirs();
  t.onTestFinished(scripts.cleanup);
  t.onTestFinished(entries.cleanup);
  await writeJson(entries.src, 'managed.json', registryEntry('managed', '2026.7.29'));

  const updated = await syncManagedHooks({
    srcDir: scripts.src,
    dstDir: scripts.dst,
    entrySrcDir: entries.src,
    entryDstDir: entries.dst,
  });

  assert.deepEqual(updated, ['config/hooks/managed.json']);
  assert.ok(existsSync(path.join(entries.dst, 'managed.json')));
});
