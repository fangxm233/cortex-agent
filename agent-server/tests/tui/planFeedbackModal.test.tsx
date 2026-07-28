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

  const output1 = instance.lastFrame();
  assert.ok(output1.includes('● 1. Approve'), 'approve shows selected indicator after hotkey 1');

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

  const output1 = instance.lastFrame();
  assert.ok(output1.includes('● 2. Provide Feedback'), 'feedback shows selected indicator');

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

  const output2 = instance.lastFrame();
  assert.ok(output2.includes('revise approach'), 'feedback text visible in input');

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

  const output1 = instance.lastFrame();
  assert.ok(output1.includes('● 3. Cancel'), 'cancel shows selected indicator');

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

test('PlanFeedbackModal submit button submits selected option', async () => {
  const frames: TuiFrame[] = [];

  const app = React.createElement(PlanFeedbackModal, {
    modal: PLAN_APPROVAL_MODAL,
    triggerId: 'tr-plan-7',
    sendFrame: (f: TuiFrame) => { frames.push(f); },
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Default selection is approve. Navigate to submit via arrows (arrows don't change selection).
  // After 3 down arrows: ▶ is on submit, ● is still on approve (default).
  instance.stdin.write('\x1b[B'); // ▶ feedback
  await delay(50);
  instance.stdin.write('\x1b[B'); // ▶ cancel
  await delay(50);
  instance.stdin.write('\x1b[B'); // ▶ submit
  await delay(50);

  // Enter on submit — submits with active selection (approve, unchanged by arrows)
  instance.stdin.write('\r');
  await delay(100);

  assert.equal(frames.length, 1, 'submit button sends frame');
  const submitFrame = frames[0] as any;
  assert.equal(submitFrame.type, 'modal.submit');
  assert.equal(submitFrame.values.decision?.decision?.value, 'approve', 'submits with approve (default selection)');

  instance.unmount();
  instance.cleanup();
});

test('PlanFeedbackModal displays ack errors inline', async () => {
  const app = React.createElement(PlanFeedbackModal, {
    modal: PLAN_APPROVAL_MODAL,
    triggerId: 'tr-plan-8',
    sendFrame: () => {},
    ackErrors: { decision: 'Please make a selection' },
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Please make a selection'), 'ack error message displayed');
  assert.ok(output.includes('Your decision'), 'field label visible in error context');

  instance.unmount();
  instance.cleanup();
});

test('PlanFeedbackModal backspace in feedback mode', async () => {
  const frames: TuiFrame[] = [];

  const app = React.createElement(PlanFeedbackModal, {
    modal: PLAN_APPROVAL_MODAL,
    triggerId: 'tr-plan-9',
    sendFrame: (f: TuiFrame) => { frames.push(f); },
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Select feedback and enter text input mode
  instance.stdin.write('2');
  await delay(50);
  instance.stdin.write('\r');
  await delay(50);

  // Type text (character by character)
  instance.stdin.write('h');
  await delay(30);
  instance.stdin.write('e');
  await delay(30);
  instance.stdin.write('l');
  await delay(30);
  instance.stdin.write('l');
  await delay(30);
  instance.stdin.write('o');
  await delay(100);

  // Backspace
  instance.stdin.write('\b');
  await delay(100);

  instance.stdin.write('\r');
  await delay(100);

  assert.equal(frames.length, 1, 'frame sent after feedback submit');
  assert.equal((frames[0] as any).values.feedback?.text?.value, 'hell');

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
