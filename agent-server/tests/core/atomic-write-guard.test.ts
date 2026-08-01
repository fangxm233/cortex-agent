// input:  atomic writes, filesystem, abort signals, test env
// output: tripwire, mode, cancellation, and serialization tests
// pos:    Atomic-write safety regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWrite, mutateFileAtomically } from '../../src/core/atomic-write.js';

const REAL_HOME_CORTEX = path.join(os.homedir(), '.cortex');

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function resolvesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), ms)),
  ]);
}

test('blocks a test-process write under the real ~/.cortex (and writes nothing)', async () => {
  // NODE_TEST_CONTEXT is set by the node test runner — assert our premise.
  assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: running under node test runner');
  const target = path.join(REAL_HOME_CORTEX, 'data', '__guard_probe_should_never_exist.json');
  assert.equal(existsSync(target), false, 'precondition: probe file absent');

  await assert.rejects(
    () => atomicWrite(target, '{"polluted":true}'),
    /~\/\.cortex|production|_test-home|CORTEX_HOME/i,
    'must throw a guidance error mentioning the remedy',
  );
  // Critical: the guard fires BEFORE any write, so the real store is untouched.
  assert.equal(existsSync(target), false, 'no file was created under the real home');
});

test('blocks a mutation before creating real-home lock state', async (t) => {
  const target = path.join(REAL_HOME_CORTEX, 'data', '__mutation_guard_probe.json');
  const mkdirSpy = vi.spyOn(fsPromises, 'mkdir').mockImplementation(async () => {
    throw new Error('unexpected lock creation');
  });
  t.onTestFinished(() => mkdirSpy.mockRestore());

  await assert.rejects(
    () => mutateFileAtomically(target, contents => contents),
    /~\/\.cortex|production|_test-home|CORTEX_HOME/i,
  );
  assert.equal(mkdirSpy.mock.calls.length, 0);
});

test('creates restricted atomic temp files with the requested mode', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atomic-mode-'));
  const target = path.join(dir, 'secret.env');
  const originalWrite = fsPromises.writeFile.bind(fsPromises);
  const creationModes: Array<number | string | undefined> = [];
  const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (file, data, options) => {
    creationModes.push(typeof options === 'object' ? options.mode : undefined);
    return originalWrite(file, data, options);
  });
  t.onTestFinished(() => { spy.mockRestore(); rmSync(dir, { recursive: true, force: true }); });

  await atomicWrite(target, 'secret', { mode: 0o600 });

  assert.deepEqual(creationModes, [0o600]);
});

test('abort after temp write prevents rename and removes the secret tempfile', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atomic-abort-'));
  const target = path.join(dir, 'secret.env');
  writeFileSync(target, 'ORIGINAL=1\n', { mode: 0o600 });
  const wroteTemp = deferred();
  const releaseWrite = deferred();
  const originalWrite = fsPromises.writeFile.bind(fsPromises);
  const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (file, data, options) => {
    await originalWrite(file, data, options);
    if (String(file).includes('.tmp.')) {
      wroteTemp.resolve();
      await releaseWrite.promise;
    }
  });
  t.onTestFinished(() => { spy.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  const controller = new AbortController();
  const write = atomicWrite(target, 'SECRET=fixture\n', { mode: 0o600, signal: controller.signal });
  await wroteTemp.promise;

  controller.abort(new Error('fixture write cancelled'));
  releaseWrite.resolve();

  await assert.rejects(write, /fixture write cancelled/);
  assert.equal(readFileSync(target, 'utf8'), 'ORIGINAL=1\n');
  const tempfiles = (await fsPromises.readdir(dir)).filter(name => name.includes('.tmp.'));
  assert.deepEqual(tempfiles, []);
});

test('repairs the requested mode after an idempotent mutation', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atomic-mode-repair-'));
  const target = path.join(dir, 'secret.env');
  writeFileSync(target, 'SECRET=fixture\n', { mode: 0o644 });
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  await mutateFileAtomically(target, contents => contents, { mode: 0o600 });

  assert.equal(statSync(target).mode & 0o777, 0o600);
});

test('serializes overlapping mutations around an async transform barrier', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atomic-mutation-'));
  const target = path.join(dir, '.env');
  writeFileSync(target, 'BASE=1\n');
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const firstGate = deferred();
  const firstEntered = deferred();

  const first = mutateFileAtomically(target, async contents => {
    firstEntered.resolve();
    await firstGate.promise;
    return `${contents}ANTHROPIC_API_KEY=fixture\n`;
  });
  await firstEntered.promise;
  const secondEntered = deferred();
  const second = mutateFileAtomically(target, contents => {
    secondEntered.resolve();
    return `${contents}FEISHU_AUTH_MODE=user\n`;
  });
  const enteredEarly = await resolvesWithin(secondEntered.promise, 50);
  firstGate.resolve();
  await Promise.all([first, second]);

  assert.equal(enteredEarly, false);
  assert.equal(
    readFileSync(target, 'utf8'),
    'BASE=1\nANTHROPIC_API_KEY=fixture\nFEISHU_AUTH_MODE=user\n',
  );
});

test('allows writes outside the real ~/.cortex (explicit temp path)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atomic-guard-'));
  const target = path.join(dir, 'ok.json');
  try {
    await atomicWrite(target, '{"ok":true}');
    assert.equal(existsSync(target), true, 'temp write succeeds — guard does not over-fire');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
