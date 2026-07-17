// input:  Node test runner, update-state module
// output: round-trip / missing-file / malformed-json coverage
// pos:    DR-0013 persistent update-state I/O

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadUpdateState,
  saveUpdateState,
  _testSetStateFile,
} from '../src/domain/system/update-state.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;
let stateFile: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-state-test-'));
  stateFile = path.join(tmpDir, 'update-state.json');
  _testSetStateFile(stateFile);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────

test('round-trip: save then load returns same object', () => {
  const state = {
    skippedVersion: '1.2.3',
    lastCheckedAt: new Date().toISOString(),
    lastPromptedVersion: '1.0.0',
  };
  saveUpdateState(state);
  const loaded = loadUpdateState();
  assert.deepEqual(loaded, state);
});

test('missing file returns null', () => {
  // Ensure file does not exist
  try { fs.unlinkSync(stateFile); } catch { /* ok */ }
  assert.equal(loadUpdateState(), null);
});

test('malformed JSON returns null (no throw)', () => {
  fs.writeFileSync(stateFile, 'not valid json');
  assert.equal(loadUpdateState(), null);
});
