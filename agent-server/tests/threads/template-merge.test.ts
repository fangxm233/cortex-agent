// Tests for mergeThreadTemplates (directory form, DR-0017 D6 Phase 2.5) — per-file copy-if-missing
// from the defaults thread-templates/ dir into the user's config dir: new entity files propagate,
// existing user files are never overwritten (aligned with plugin-sync semantics).

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
    writeJson(join(defaultsDir, 'shells', 'worker-review.json'), { params: ['worker', 'reviewer'], agents: ['{worker}', '{reviewer}'], transitions: [], entryAgent: '{worker}', maxTotalSteps: 4 });
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
