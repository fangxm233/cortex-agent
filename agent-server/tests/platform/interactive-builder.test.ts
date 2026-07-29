// input:  interactive-builder question group builders
// output: severity-level banner and modal title prefix tests
// pos:    Regression guard for ask-card level rendering on block platforms
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildQuestionGroupBlocks,
  buildQuestionModalDefinition,
  type QuestionGroup,
} from '../../src/platform/interactive-builder.js';

function makeGroup(level?: 'info' | 'warning' | 'error'): QuestionGroup {
  return {
    groupId: 'g1',
    level,
    questions: [{
      pendingId: 'p1',
      header: 'Gate',
      question: 'Continue?',
      options: [{ label: 'Yes' }, { label: 'No' }],
      multiSelect: false,
    }],
    answers: new Map(),
  };
}

test('blocks start with a level banner for warning and error groups', () => {
  const warning = buildQuestionGroupBlocks(makeGroup('warning'));
  assert.equal(warning[0].type, 'context');
  assert.ok(String((warning[0] as any).text).includes('⚠️'));

  const error = buildQuestionGroupBlocks(makeGroup('error'));
  assert.ok(String((error[0] as any).text).includes('❌'));
});

test('an explicit info level renders the info banner', () => {
  const info = buildQuestionGroupBlocks(makeGroup('info'));
  assert.equal(info[0].type, 'context');
  assert.ok(String((info[0] as any).text).includes('ℹ️'));
});

test('blocks without a level keep the legacy shape (no banner)', () => {
  const blocks = buildQuestionGroupBlocks(makeGroup());
  assert.equal(blocks[0].type, 'section');
});

test('modal title carries the level icon prefix', () => {
  const plain = buildQuestionModalDefinition(makeGroup());
  const flagged = buildQuestionModalDefinition(makeGroup('error'));
  assert.ok(!plain.title.includes('❌'));
  assert.ok(flagged.title.startsWith('❌'), `title: ${flagged.title}`);
});
