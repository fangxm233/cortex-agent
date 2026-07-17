// input:  agent-adapter/claude/adapter resolveResumeForPrint
// output: Unit tests for the print-mode resume guard
// pos:    Guards the "No conversation found with session ID" bug on the cortex tui
//         (print-mode) path — a pre-registered sessionId must NOT trigger --resume
//         until Claude has actually written a transcript for it.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveResumeForPrint } from '../../src/agent-adapter/claude/adapter.js';

test('resolveResumeForPrint: requested resume but no transcript → create (false)', () => {
  // The cortex tui frontend pre-registers a sessionId at handshake, so the first
  // turn arrives with resume=true even though Claude has written nothing yet.
  assert.equal(resolveResumeForPrint(true, 'fresh-session-id', () => false), false);
});

test('resolveResumeForPrint: requested resume and transcript exists → resume (true)', () => {
  assert.equal(resolveResumeForPrint(true, 'existing-session-id', () => true), true);
});

test('resolveResumeForPrint: not requested → never resumes regardless of transcript', () => {
  assert.equal(resolveResumeForPrint(false, 'existing-session-id', () => true), false);
});
