// input:  Vitest, temp config trees, thread-template merger
// output: Default-copy and legacy-shell upgrade regressions
// pos:    Verifies safe thread-template config propagation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeThreadTemplates } from '../../src/domain/threads/index.js';

function writeJson(p: string, obj: unknown): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

describe('mergeThreadTemplates (directory form)', () => {
  let tmpDir: string;
  let defaultsDir: string;
  let userDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-merge-test-'));
    defaultsDir = join(tmpDir, 'defaults');
    userDir = join(tmpDir, 'user');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedDefaults(): void {
    writeJson(join(defaultsDir, 'agents', 'main.json'), { name: 'main', profile: '__active__', persistSession: true, promptTemplate: '{{input}}' });
    writeJson(join(defaultsDir, 'agents', 'worker.json'), { name: 'worker', profile: '__active__', persistSession: false, promptTemplate: '{{input}}' });
    writeJson(join(defaultsDir, 'templates', 'default.json'), { name: 'default', description: 'd', agents: ['main'], transitions: [], entryAgent: 'main', maxTotalSteps: 1 });
    writeJson(join(defaultsDir, 'shells', 'worker-review.json'), {
      params: ['worker', 'reviewer'],
      agents: ['{worker}', '{reviewer}'],
      transitions: [
        { from: '{worker}:{worker.entryStage}', to: '{reviewer}', condition: { type: 'always' } },
        { from: '{reviewer}', to: '{worker}:retry', condition: { type: 'convergence', marker: '[APPROVED]', maxIterations: 1 } },
        { from: '{worker}:retry', to: '{reviewer}', condition: { type: 'output_contains', pattern: '\\[REVISED\\]' } },
      ],
      entryAgent: '{worker}',
      entryStage: '{worker.entryStage}',
      maxTotalSteps: 4,
    });
  }

  it('copies the full defaults tree when the user dir is empty', () => {
    seedDefaults();
    const changed = mergeThreadTemplates(defaultsDir, userDir);
    assert.equal(changed, true);
    assert.ok(existsSync(join(userDir, 'agents', 'main.json')));
    assert.ok(existsSync(join(userDir, 'agents', 'worker.json')));
    assert.ok(existsSync(join(userDir, 'templates', 'default.json')));
    assert.ok(existsSync(join(userDir, 'shells', 'worker-review.json')));
  });

  it('adds only the missing files and preserves existing user files', () => {
    seedDefaults();
    // user already has a customized main.json
    const customMain = JSON.stringify({ name: 'main', profile: 'CUSTOM', persistSession: true }, null, 2);
    mkdirSync(join(userDir, 'agents'), { recursive: true });
    writeFileSync(join(userDir, 'agents', 'main.json'), customMain, 'utf8');

    const changed = mergeThreadTemplates(defaultsDir, userDir);
    assert.equal(changed, true);
    // customization preserved
    assert.equal(readFileSync(join(userDir, 'agents', 'main.json'), 'utf8'), customMain);
    // new files added
    assert.ok(existsSync(join(userDir, 'agents', 'worker.json')));
    assert.ok(existsSync(join(userDir, 'shells', 'worker-review.json')));
  });

  it('upgrades only an unchanged legacy worker-review shell', () => {
    seedDefaults();
    const shellPath = join('shells', 'worker-review.json');
    const current = JSON.parse(readFileSync(join(defaultsDir, shellPath), 'utf8'));
    const legacy = structuredClone(current);
    legacy.transitions[2].condition.type = 'output_not_contains';
    writeJson(join(userDir, shellPath), legacy);

    assert.equal(mergeThreadTemplates(defaultsDir, userDir), true);
    assert.deepEqual(JSON.parse(readFileSync(join(userDir, shellPath), 'utf8')), current);

    const customized = structuredClone(legacy);
    customized.maxTotalSteps = 6;
    writeJson(join(userDir, shellPath), customized);
    assert.equal(mergeThreadTemplates(defaultsDir, userDir), false);
    assert.deepEqual(JSON.parse(readFileSync(join(userDir, shellPath), 'utf8')), customized);
  });

  it('returns false when the user dir already has everything', () => {
    seedDefaults();
    mergeThreadTemplates(defaultsDir, userDir); // first pass copies all
    const changed = mergeThreadTemplates(defaultsDir, userDir); // second pass no-op
    assert.equal(changed, false);
  });

  it('returns false when the defaults dir does not exist', () => {
    const changed = mergeThreadTemplates(join(tmpDir, 'nonexistent'), userDir);
    assert.equal(changed, false);
  });
});
