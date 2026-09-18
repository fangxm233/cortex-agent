// input:  src/tui/components/PlanFeedbackModal.tsx
// output: verifies approve/feedback/cancel submission, editing, errors, and Escape outcomes
// pos:    Plan-approval interaction contract; option chrome/indicators are not snapshot-tested

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { PlanFeedbackModal } from '../../src/tui/components/PlanFeedbackModal.js';
import type { ModalDefinition, TuiFrame } from '../../src/platform/tui/protocol.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fixture ──

const PLAN_APPROVAL_MODAL: ModalDefinition = {
  callbackId: 'plan_approval_req-1',
  title: 'Plan Review',
  submitLabel: 'Confirm',
  closeLabel: 'Back',
  privateMetadata: JSON.stringify({ requestId: 'req-1' }),
  fields: [
    {
      type: 'section',
      text: 'Implement new API endpoint for user authentication.\n\n**Plan:**\n1. Add JWT middleware\n2. Create auth controller\n3. Add tests',
    },
    {
      type: 'select',
      blockId: 'decision',
      label: 'Your decision',
      actionId: 'decision',
      options: [
        { label: 'Approve', value: 'approve' },
        { label: 'Provide Feedback', value: 'feedback' },
        { label: 'Cancel', value: 'cancel' },
      ],
    },
    {
      type: 'text_input',
      blockId: 'feedback',
      label: 'Your feedback',
      actionId: 'text',
      placeholder: 'What should be changed?',
      multiline: true,
    },
  ],
};

// ── Tests ──

test('PlanFeedbackModal hotkey 1 selects approve, Enter submits', async () => {
  const frames: TuiFrame[] = [];

  const app = React.createElement(PlanFeedbackModal, {
    modal: PLAN_APPROVAL_MODAL,
    triggerId: 'tr-plan-2',
    sendFrame: (f: TuiFrame) => { frames.push(f); },
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Press '1' to select Approve
  instance.stdin.write('1');
  await delay(100);

  // Enter to submit
  instance.stdin.write('\r');
  await delay(100);

  assert.equal(frames.length, 1, 'exactly one frame sent');
  const submitFrame = frames[0] as any;
  assert.equal(submitFrame.type, 'modal.submit');
  assert.equal(submitFrame.callbackId, 'plan_approval_req-1');
  assert.equal(submitFrame.values.decision?.decision?.value, 'approve');

  instance.unmount();
  instance.cleanup();
});

test('PlanFeedbackModal hotkey 2 enters feedback mode, text input, Enter submits', async () => {
  const frames: TuiFrame[] = [];

  const app = React.createElement(PlanFeedbackModal, {
    modal: PLAN_APPROVAL_MODAL,
    triggerId: 'tr-plan-3',
    sendFrame: (f: TuiFrame) => { frames.push(f); },
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Press '2' to select Provide Feedback
  instance.stdin.write('2');
  await delay(100);

  // Enter to enter feedback text input mode
  instance.stdin.write('\r');
  await delay(100);

  // Type feedback text (character by character with delays, matching AskUserModal pattern)
  instance.stdin.write('r');
  await delay(30);
  instance.stdin.write('e');
  await delay(30);
  instance.stdin.write('v');
  await delay(30);
  instance.stdin.write('i');
  await delay(30);
  instance.stdin.write('s');
  await delay(30);
  instance.stdin.write('e');
  await delay(50);
  instance.stdin.write(' ');
  await delay(50);
  instance.stdin.write('a');
  await delay(30);
  instance.stdin.write('p');
  await delay(30);
  instance.stdin.write('p');
  await delay(30);
  instance.stdin.write('r');
  await delay(30);
  instance.stdin.write('o');
  await delay(30);
  instance.stdin.write('a');
  await delay(30);
  instance.stdin.write('c');
  await delay(30);
  instance.stdin.write('h');
  await delay(100);

  // Enter to submit
  instance.stdin.write('\r');
  await delay(100);

  assert.equal(frames.length, 1, 'exactly one frame sent');
  const submitFrame = frames[0] as any;
  assert.equal(submitFrame.type, 'modal.submit');
  assert.equal(submitFrame.callbackId, 'plan_approval_req-1');
  assert.equal(submitFrame.values.decision?.decision?.value, 'feedback');
  assert.equal(submitFrame.values.feedback?.text?.value, 'revise approach');

  instance.unmount();
  instance.cleanup();
});

test('PlanFeedbackModal hotkey 3 selects cancel, Enter calls onClose', async () => {
  let closeCalled = false;

  const app = React.createElement(PlanFeedbackModal, {
    modal: PLAN_APPROVAL_MODAL,
    triggerId: 'tr-plan-4',
    sendFrame: () => {},
    ackErrors: {},
    onClose: () => { closeCalled = true; },
  });

  const instance = render(app);
  await delay(100);

  // Press '3' to select Cancel
  instance.stdin.write('3');
  await delay(100);

  // Enter to confirm cancel
  instance.stdin.write('\r');
  await delay(100);

  assert.equal(closeCalled, true, 'Enter on cancel calls onClose');

  instance.unmount();
  instance.cleanup();
});

test('PlanFeedbackModal Escape closes without submitting', async () => {
  let closeCalled = false;

  const app = React.createElement(PlanFeedbackModal, {
    modal: PLAN_APPROVAL_MODAL,
    triggerId: 'tr-plan-5',
    sendFrame: () => {},
    ackErrors: {},
    onClose: () => { closeCalled = true; },
  });

  const instance = render(app);
  await delay(100);

  instance.stdin.write('\x1b'); // Escape
  await delay(100);

  assert.equal(closeCalled, true, 'Escape calls onClose');

  instance.unmount();
  instance.cleanup();
});

test('PlanFeedbackModal Esc in feedback mode returns to decision mode, second Esc closes', async () => {
  let closeCalled = false;

  const app = React.createElement(PlanFeedbackModal, {
    modal: PLAN_APPROVAL_MODAL,
    triggerId: 'tr-plan-10',
    sendFrame: () => {},
    ackErrors: {},
    onClose: () => { closeCalled = true; },
  });

  const instance = render(app);
  await delay(100);

  // Enter feedback mode
  instance.stdin.write('2');
  await delay(50);
  instance.stdin.write('\r');
  await delay(50);

  // Type something (character by character)
  instance.stdin.write('w');
  await delay(30);
  instance.stdin.write('i');
  await delay(30);
  instance.stdin.write('p');
  await delay(50);

  // Esc exits feedback mode (back to decision)
  instance.stdin.write('\x1b');
  await delay(100);

  // Second Esc closes
  instance.stdin.write('\x1b');
  await delay(100);

  assert.equal(closeCalled, true, 'second Esc after exiting feedback mode calls onClose');

  instance.unmount();
  instance.cleanup();
});
