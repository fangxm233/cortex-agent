import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { buildThreadStatusMessage } from '../../src/core/status-format.js';
import { Icons } from '../../src/core/icons.js';

describe('buildThreadStatusMessage', () => {
  it('leads with task identity when task info is present', () => {
    const msg = buildThreadStatusMessage({
      threadId: 'thr_0be02bc5aaaa',
      stepNumber: 1,
      label: 'coder:plan',
      elapsedS: 34,
      taskProject: 'beacon-nav',
      taskId: 'a3be',
      taskText: 'Implement contact encoder baseline',
    });
    // task project + text + id come first, before the step
    assert.ok(msg.startsWith(`${Icons.processing} [beacon-nav] Implement contact encoder baseline`), msg);
    assert.ok(msg.includes('`a3be`'), msg);
    assert.ok(msg.includes('Step 1: *coder:plan*'), msg);
    // short thread id retained for thread-op debugging
    assert.ok(msg.includes('thr_0be02bc5'), msg);
    assert.ok(msg.includes(`${Icons.stopwatch} 34s`), msg);
  });

  it('truncates long task text with an ellipsis', () => {
    const longText = 'A'.repeat(120);
    const msg = buildThreadStatusMessage({
      threadId: 'thr_deadbeef0000',
      stepNumber: 2,
      label: 'reviewer',
      elapsedS: 5,
      taskProject: 'proj',
      taskId: 'b1c2',
      taskText: longText,
    });
    assert.ok(msg.includes('…'), msg);
    // full 120-char text must not appear verbatim
    assert.ok(!msg.includes(longText), msg);
  });

  it('falls back to the thread-only format when no task info', () => {
    const msg = buildThreadStatusMessage({
      threadId: 'thr_0be02bc5aaaa',
      stepNumber: 1,
      label: 'coder:plan',
      elapsedS: 34,
    });
    assert.equal(
      msg,
      `${Icons.processing} Thread thr_0be02bc5 | Step 1: *coder:plan* | ${Icons.stopwatch} 34s`,
    );
  });

  it('renders turn count after the label when provided', () => {
    const msg = buildThreadStatusMessage({
      threadId: 'thr_0be02bc5aaaa',
      stepNumber: 1,
      label: 'coder:plan',
      elapsedS: 34,
      numTurns: 14,
      taskProject: 'proj',
      taskId: 'a3be',
      taskText: 'do thing',
    });
    assert.ok(msg.includes('Step 1: *coder:plan* (14 turns)'), msg);
  });

  it('truncates the thread id to 12 chars in both formats', () => {
    const withTask = buildThreadStatusMessage({
      threadId: 'thr_0be02bc5aaaabbbb',
      stepNumber: 1,
      label: 'x',
      elapsedS: 1,
      taskProject: 'p',
      taskId: 'id',
      taskText: 't',
    });
    assert.ok(withTask.includes('thr_0be02bc5'), withTask);
    assert.ok(!withTask.includes('thr_0be02bc5aaaa'), withTask);
  });
});
