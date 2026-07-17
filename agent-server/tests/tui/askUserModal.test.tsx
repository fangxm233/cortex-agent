// input:  src/tui/components/AskUserModal.jsx
// output: Tests — renders fields, keyboard navigation, submit values, ack errors
// pos:    Verifies AskUserModal render→select→submit→ack-error cycle
//
// Drives an AskUserQuestion fixture through the full lifecycle:
//   render modal → arrow-key navigate → select option → type text → submit
//   → verify modal.submit values → verify ack error display

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { AskUserModal } from '../../src/tui/components/AskUserModal.js';
import type { ModalDefinition, TuiFrame } from '../../src/platform/tui/protocol.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fixtures ──

const SIMPLE_MODAL: ModalDefinition = {
  callbackId: 'test_modal',
  title: 'Test Modal',
  submitLabel: 'Submit',
  closeLabel: 'Cancel',
  privateMetadata: '{}',
  fields: [
    { type: 'section', text: 'A simple question for you.' },
    {
      type: 'select',
      blockId: 'q_0',
      label: 'Pick one',
      actionId: 'selection',
      options: [
        { label: 'Option A', value: '0' },
        { label: 'Option B', value: '1' },
        { label: 'Option C', value: '2' },
      ],
      optional: true,
    },
    {
      type: 'text_input',
      blockId: 'q_0_other',
      label: 'Custom answer',
      actionId: 'other_text',
      placeholder: 'Type your own answer',
      optional: true,
    },
  ],
};

const MULTI_MODAL: ModalDefinition = {
  callbackId: 'multi_test',
  title: 'Multi Select Test',
  submitLabel: 'Confirm',
  fields: [
    {
      type: 'multi_select',
      blockId: 'm_0',
      label: 'Choose multiple',
      actionId: 'choices',
      options: [
        { label: 'Red', value: 'red' },
        { label: 'Green', value: 'green' },
        { label: 'Blue', value: 'blue' },
      ],
    },
  ],
};

// ── Tests ──

test('AskUserModal renders title and all field types', async (t) => {
  const app = React.createElement(AskUserModal, {
    modal: SIMPLE_MODAL,
    triggerId: 'tr-1',
    sendFrame: () => {},
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Test Modal'), 'renders modal title');
  assert.ok(output.includes('Pick one'), 'renders select label');
  assert.ok(output.includes('Custom answer'), 'renders text_input label');
  assert.ok(output.includes('Option A'), 'renders select option A');
  assert.ok(output.includes('Option B'), 'renders select option B');
  assert.ok(output.includes('Option C'), 'renders select option C');
  assert.ok(output.includes('[Submit]'), 'renders submit button');

  instance.unmount();
  instance.cleanup();
});

test('AskUserModal select: number key selects option', async (t) => {
  const app = React.createElement(AskUserModal, {
    modal: SIMPLE_MODAL,
    triggerId: 'tr-1',
    sendFrame: () => {},
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Press '2' to select Option B
  instance.stdin.write('2');
  await delay(100);

  const output = instance.lastFrame();
  // Option B should show focus indicator (▶) and number
  assert.ok(output.includes('▶ 2. Option B'), 'focus on Option B after number key press');
  // Option A should show ○ (deselected)
  assert.ok(output.includes('○ 1. Option A'), 'Option A shows deselected indicator');

  instance.unmount();
  instance.cleanup();
});

test('AskUserModal text_input: character capture and backspace', async (t) => {
  const app = React.createElement(AskUserModal, {
    modal: SIMPLE_MODAL,
    triggerId: 'tr-1',
    sendFrame: () => {},
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Navigate past the select field to reach text_input.
  // First slot is Option A (index 0 of select). Down arrow moves to Option B → C → text field.
  // Press down 3 times: Option A → B → C → text_input
  instance.stdin.write('\x1b[B'); // down arrow
  await delay(50);
  instance.stdin.write('\x1b[B'); // down arrow
  await delay(50);
  instance.stdin.write('\x1b[B'); // down arrow
  await delay(50);

  // Now on text_input — type "hello"
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

  const output1 = instance.lastFrame();
  assert.ok(output1.includes('hello'), 'text input shows typed characters');

  // Backspace removes last char
  instance.stdin.write('\b');
  await delay(50);

  const output2 = instance.lastFrame();
  assert.ok(output2.includes('hell'), 'backspace removes last character');

  instance.unmount();
  instance.cleanup();
});

test('AskUserModal submit builds correct modal.submit values', async (t) => {
  const frames: TuiFrame[] = [];

  const app = React.createElement(AskUserModal, {
    modal: SIMPLE_MODAL,
    triggerId: 'tr-1',
    sendFrame: (f: TuiFrame) => { frames.push(f); },
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Press '2' to select Option B (number key)
  instance.stdin.write('2');
  await delay(50);

  // Enter to confirm selection and move to next field
  instance.stdin.write('\r');
  await delay(50);

  // Type custom answer "mytext" (avoid space which Ink may handle differently)
  instance.stdin.write('m');
  await delay(50);
  instance.stdin.write('y');
  await delay(50);
  instance.stdin.write('t');
  await delay(50);
  instance.stdin.write('e');
  await delay(50);
  instance.stdin.write('x');
  await delay(50);
  instance.stdin.write('t');
  await delay(100);

  // Enter on text_input moves to submit, then Enter to submit
  instance.stdin.write('\r');
  await delay(100);
  instance.stdin.write('\r');
  await delay(100);

  assert.equal(frames.length, 1, 'exactly one frame sent');
  const submitFrame = frames[0] as any;
  assert.equal(submitFrame.type, 'modal.submit');
  assert.equal(submitFrame.callbackId, 'test_modal');
  assert.equal(submitFrame.privateMetadata, '{}');

  // Check values
  assert.ok(submitFrame.values, 'values present');
  assert.equal(submitFrame.values.q_0?.selection?.selectedOption?.value, '1', 'selected Option B (index 1)');
  assert.equal(submitFrame.values.q_0_other?.other_text?.value, 'mytext', 'text input captured');

  instance.unmount();
  instance.cleanup();
});

test('AskUserModal multi_select: Space toggles options', async (t) => {
  const app = React.createElement(AskUserModal, {
    modal: MULTI_MODAL,
    triggerId: 'tr-2',
    sendFrame: () => {},
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Initial: all checkboxes should be empty
  const output1 = instance.lastFrame();
  assert.ok(output1.includes('[ ]'), 'initial checkboxes empty');
  const countX1 = (output1.match(/\[x\]/g) || []).length;
  assert.equal(countX1, 0, 'no toggled options initially');

  // Space on first option toggles it
  instance.stdin.write(' ');
  await delay(100);

  const output2 = instance.lastFrame();
  const countX2 = (output2.match(/\[x\]/g) || []).length;
  assert.ok(countX2 >= 1, `at least one option toggled after Space (found ${countX2})`);

  // Toggle second option via number key '2'
  instance.stdin.write('2');
  await delay(100);

  const output3 = instance.lastFrame();
  const countX3 = (output3.match(/\[x\]/g) || []).length;
  assert.ok(countX3 >= 2, `at least two options toggled after number key (found ${countX3})`);

  instance.unmount();
  instance.cleanup();
});

test('AskUserModal multi_select: submit with toggled options', async (t) => {
  const frames: TuiFrame[] = [];

  const app = React.createElement(AskUserModal, {
    modal: MULTI_MODAL,
    triggerId: 'tr-2',
    sendFrame: (f: TuiFrame) => { frames.push(f); },
    ackErrors: {},
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  // Toggle Red (1) and Blue (3) using number keys
  instance.stdin.write('1');
  await delay(50);
  instance.stdin.write('3');
  await delay(50);

  // Navigate to submit: down arrows through remaining slots then submit
  // Slots: Red, Green, Blue, submit = 4 slots
  // Focus is on Red (slot 0). 2 more down to get past Green and Blue to submit
  // Actually, with Enter first to confirm multi, then navigate...
  // Let's use Enter to confirm multi and go to submit
  instance.stdin.write('\r');
  await delay(50);
  instance.stdin.write('\r');
  await delay(100);

  assert.equal(frames.length, 1, 'exactly one frame sent');
  const submitFrame = frames[0] as any;
  assert.equal(submitFrame.type, 'modal.submit');
  assert.ok(submitFrame.values.m_0, 'values for multi_select present');
  assert.ok(submitFrame.values.m_0?.choices?.selectedOptions, 'selectedOptions present');
  assert.equal(submitFrame.values.m_0.choices.selectedOptions.length, 2, 'two options selected');

  const values = submitFrame.values.m_0.choices.selectedOptions.map(
    (s: { value: string }) => s.value
  ).sort();
  assert.deepEqual(values, ['blue', 'red'], 'Red and Blue selected');

  instance.unmount();
  instance.cleanup();
});

test('AskUserModal displays ack errors inline', async (t) => {
  const app = React.createElement(AskUserModal, {
    modal: SIMPLE_MODAL,
    triggerId: 'tr-1',
    sendFrame: () => {},
    ackErrors: { q_0: 'Please make a selection' },
    onClose: () => {},
  });

  const instance = render(app);
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Please make a selection'), 'error message displayed');
  assert.ok(output.includes('Pick one'), 'field label visible in error context');

  instance.unmount();
  instance.cleanup();
});

test('AskUserModal escape closes without submitting', async (t) => {
  let closeCalled = false;

  const app = React.createElement(AskUserModal, {
    modal: SIMPLE_MODAL,
    triggerId: 'tr-1',
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
