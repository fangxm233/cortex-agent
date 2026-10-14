//
// Every expectation below is the byte-for-byte output of the implementation this file replaced
// (threads/prompt-builder.buildConversationPrompt + buildRegularStepPrompt + appendPendingMessages,
// and engine-spec.rulesPrompt). Equivalence was established over 40k randomized cases before the
// old code was deleted; these fixtures are the durable record of it, driven by the templates the
// shipped agent definitions really carry (main, direct, direct-review, doc-reviewer, coder).

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { composeSystemPrompt, composeUserPrompt } from '../../../src/domain/runs/prompt.js';
import type { BoardPromptContext } from '../../../src/domain/boards/board-context.js';

// --- composeSystemPrompt: the ambient rules, then the caller's own text ---

test('no rules and no role body appends nothing at all', () => {
  assert.equal(composeSystemPrompt({}), undefined);
  assert.equal(composeSystemPrompt({ appendSystemPrompt: null }, { rules: [] }), undefined);
});

test('a whitespace-only role body contributes nothing', () => {
  assert.equal(composeSystemPrompt({ appendSystemPrompt: '   \n ' }), undefined);
  assert.equal(
    composeSystemPrompt({ appendSystemPrompt: '   ' }, { rules: ['rule one'] }),
    'rule one',
  );
});

// --- composeUserPrompt: the conversation shape (no thread, no artifact) ---

test('the `{{input}}` agent with no directive is the message, trimmed', () => {
  assert.equal(composeUserPrompt({ promptTemplate: '{{input}}' }, 'hello world'), 'hello world');
  assert.equal(composeUserPrompt({ promptTemplate: '{{input}}' }, '  padded  '), 'padded');
});

test('an absent template means the input verbatim', () => {
  assert.equal(composeUserPrompt({}, 'hello'), 'hello');
  assert.equal(composeUserPrompt({ promptTemplate: null }, 'hello'), 'hello');
});

test('prefix order is user profile, directive, project, transcripts, board', () => {
  const prompt = composeUserPrompt(
    { directive: 'DIRECTIVE', promptTemplate: '{{input}}' },
    'BODY',
    {
      userContext: '[User Context]\nprofile\n[/User Context]',
      project: { id: 'cortex', contextDir: '/ctx/cortex' },
      transcriptDir: '/data/conversation-history',
      board: { id: 'b-1', title: 'T', dir: '/d' },
    },
  );
  const order = ['[User Context]', 'DIRECTIVE', '[Session Project]', '[Session Transcripts]', '[Board]', 'BODY']
    .map((needle) => prompt.indexOf(needle));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), prompt);
  assert.ok(order.every((i) => i >= 0), prompt);
});

const BOARD: BoardPromptContext = { id: 'b-1', title: 'Ship it', dir: '/root/c/boards/ship-it' };

test('the board block names the board, its files and the editing etiquette', () => {
  const prompt = composeUserPrompt({ promptTemplate: '{{input}}' }, 'go', { board: BOARD });
  assert.equal(prompt,
    '[Board] This session is bound to the board "Ship it" (b-1).\n'
    + 'Board directory: /root/c/boards/ship-it\n'
    + '  board.html — the page body you edit (HTML, body content only); images go in assets/\n'
    + '  decisions.jsonl — written by the server from send_decision; do not edit\n'
    + '\n'
    + 'Read board.html before anything else. Other sessions may be editing it at the same time: '
    + 're-read it right before every edit and keep each edit small. Update it at milestones and '
    + 'whenever the status changes. Prefer the preset component classes from the board skill.'
    + '\n\ngo');
});

// --- composeUserPrompt: template rendering and resume ---

test('an unknown template variable renders empty, but an unknown one in the directive stays literal', () => {
  assert.equal(composeUserPrompt({ promptTemplate: 'a{{nope}}b' }, 'x'), 'ab');
  assert.equal(
    composeUserPrompt({ directive: 'keep {{nope}} literal', promptTemplate: '{{input}}' }, 'x'),
    'keep {{nope}} literal\n\nx',
  );
});

test('{{#if}} blocks keep their body only when the variable is truthy', () => {
  const template = '{{#if input}}Asked: {{input}}{{/if}}';
  assert.equal(composeUserPrompt({ promptTemplate: template }, ''), '');
  assert.equal(composeUserPrompt({ promptTemplate: template }, 'go'), 'Asked: go');
});

test('a resumed session receives the body alone — every prefix is dropped', () => {
  assert.equal(
    composeUserPrompt({ directive: 'D', promptTemplate: '{{input}}' }, 'next step', {
      userContext: '[User Context]\np\n[/User Context]',
      project: { id: 'cortex', contextDir: '/ctx' },
      board: BOARD,
      resumed: true,
    }),
    'next step',
  );
});
