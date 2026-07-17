// input:  agent-adapter/claude/adapter-tui resolveTuiResume
// output: Regression — a fresh TUI session must NOT spawn with --resume on its first turn
// pos:    Guards the "No conversation found with session ID" bug (pre-registered TUI sessionId
//         made the orchestrator request --resume on a transcript that does not exist yet)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveTuiResume } from '../../src/agent-adapter/claude/adapter-tui.js';

test('fresh TUI session (no transcript) does not resume even when resume is requested', () => {
  // The pre-registered sessionId has no Claude jsonl yet → must fall back to --session-id (create).
  assert.equal(resolveTuiResume(true, '/home/x/.claude/projects/-tmp/sid.jsonl', () => false), false);
});

test('TUI session with an existing transcript resumes when requested', () => {
  assert.equal(resolveTuiResume(true, '/home/x/.claude/projects/-tmp/sid.jsonl', () => true), true);
});

test('resume is never forced when the caller did not request it', () => {
  assert.equal(resolveTuiResume(false, '/home/x/.claude/projects/-tmp/sid.jsonl', () => true), false);
});
