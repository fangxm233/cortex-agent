// input:  agent-adapter/claude/transcript-path resolveResumeAgainstTranscript
// output: Regression — a fresh session must NOT spawn with --resume on its first turn
// pos:    Guards the "No conversation found with session ID" bug (pre-registered sessionId
//         made the orchestrator request --resume on a transcript that does not exist yet)

// NOT retired by D9: `resolveResumeAgainstTranscript` + `computeTranscriptPath` back
// `resolveResumeForPrint`, which decides --resume vs --session-id for every PRINT-mode spawn.
// They moved out of the deleted adapter-tui.ts; the resume helper's old TUI name was historical.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  computeTranscriptPath,
  resolveResumeAgainstTranscript,
} from '../../src/agent-adapter/claude/transcript-path.js';

test('fresh session (no transcript) does not resume even when resume is requested', () => {
  // The pre-registered sessionId has no Claude jsonl yet → must fall back to --session-id (create).
  assert.equal(resolveResumeAgainstTranscript(true, '/home/x/.claude/projects/-tmp/sid.jsonl', () => false), false);
});

test('session with an existing transcript resumes when requested', () => {
  assert.equal(resolveResumeAgainstTranscript(true, '/home/x/.claude/projects/-tmp/sid.jsonl', () => true), true);
});

test('resume is never forced when the caller did not request it', () => {
  assert.equal(resolveResumeAgainstTranscript(false, '/home/x/.claude/projects/-tmp/sid.jsonl', () => true), false);
});

test('computeTranscriptPath encodes BOTH slashes and dots (dotfiles like .cortex)', () => {
  const expected = path.join(
    os.homedir(), '.claude', 'projects', '-home-alice--cortex', 'sid.jsonl',
  );
  assert.equal(computeTranscriptPath('/home/alice/.cortex', 'sid'), expected);
});
