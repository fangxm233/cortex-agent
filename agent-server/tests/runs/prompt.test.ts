//
// Every expectation below is the byte-for-byte output of the implementation this file replaced
// (threads/prompt-builder.buildConversationPrompt + buildRegularStepPrompt + appendPendingMessages,
// and engine-spec.rulesPrompt). Equivalence was established over 40k randomized cases before the
// old code was deleted; these fixtures are the durable record of it, driven by the templates the
// shipped agent definitions really carry (main, direct, direct-review, doc-reviewer, coder).

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { composeSystemPrompt, composeUserPrompt } from '../../src/domain/runs/prompt.js';
import type { CommissionPromptContext } from '../../src/domain/commissions/commission-context.js';

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

test('prefix order is user profile, directive, project, commission, preamble', () => {
  const prompt = composeUserPrompt(
    { directive: 'DIRECTIVE', promptTemplate: '{{input}}' },
    'BODY',
    {
      userContext: '[User Context]\nprofile\n[/User Context]',
      project: { id: 'cortex', contextDir: '/ctx/cortex' },
      commission: { phase: 'draft', dir: '/d' },
      preamble: 'PREAMBLE',
    },
  );
  const order = ['[User Context]', 'DIRECTIVE', '[Session Project]', '[Commission]', 'PREAMBLE', 'BODY']
    .map((needle) => prompt.indexOf(needle));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), prompt);
  assert.ok(order.every((i) => i >= 0), prompt);
});

const ACTIVE: CommissionPromptContext = {
  phase: 'active', id: 'cm-1', title: 'Ship it', dir: '/root/c/cm-1', hasLedger: true,
};

test('an active commission block is an index plus the protocol, never the file contents', () => {
  const prompt = composeUserPrompt({ promptTemplate: '{{input}}' }, 'go', { commission: ACTIVE });
  assert.equal(prompt,
    '[Commission] This session belongs to the commission "Ship it" (cm-1).\n'
    + 'Commission directory: /root/c/cm-1\n'
    + '  contract.md — the binding intent reference: goal, inferences, acceptance criteria, exclusions, gates, revisions\n'
    + '  ledger.md   — your state record: Status line, Plan items, checkpoints CP-N, log entries L-NNN\n'
    + '  assets/     — rich content you generate; decisions.jsonl — server-written, never touch it\n'
    + '\n'
    + 'Read both files now, before anything else — their contents are not reproduced here, and the '
    + 'copies on disk are the only source of truth. Re-read contract.md (including its Revisions '
    + 'section) at every checkpoint; the user may have edited it since you last looked.\n'
    + '\n'
    + 'Commission protocol:\n'
    + '1. Surprises are three kinds: an obstacle you route around; a fork you align on (send_decision for low-stakes picks, a blocking question for high-stakes ones); a discovery that invalidates a contract premise. A discovery MUST be surfaced against the contract — never silently absorbed.\n'
    + '2. Completion claims need evidence pointers (file paths, command outputs, EXP ids) in ledger.md. Scope cuts and deferrals go in the plan section\'s "Cuts and deferrals" note.\n'
    + '3. Before this session ends, and at each stage boundary, append a checkpoint CP-N to ledger.md with three diffs — plan vs done, contract vs current direction, assumptions vs reality — graded ok / attention / gate. Re-read contract.md (including its Revisions section) before writing it.\n'
    + '4. Contract gates are blocking: ask the user and wait. A streak of approvals never downgrades a gate.'
    + '\n\ngo');
});

// --- composeUserPrompt: the thread-step shape ---

test('an unknown template variable renders empty, but an unknown one in the directive stays literal', () => {
  assert.equal(composeUserPrompt({ promptTemplate: 'a{{nope}}b' }, 'x'), 'ab');
  assert.equal(
    composeUserPrompt({ directive: 'keep {{nope}} literal', promptTemplate: '{{input}}' }, 'x'),
    'keep {{nope}} literal\n\nx',
  );
});

test('{{#if}} blocks keep their body only when the variable is truthy', () => {
  const template = '{{#if modifiedFiles}}Changed:\n{{modifiedFiles}}\n\n{{/if}}{{input}}';
  assert.equal(composeUserPrompt({ promptTemplate: template }, 'go'), 'go');
  assert.equal(
    composeUserPrompt({ promptTemplate: template }, 'go', { vars: { modifiedFiles: '- a.ts\n- b.ts' } }),
    'Changed:\n- a.ts\n- b.ts\n\ngo',
  );
});

test('a resumed session receives the body alone — every prefix is dropped', () => {
  assert.equal(
    composeUserPrompt({ directive: 'D', promptTemplate: '{{input}}' }, 'next step', {
      userContext: '[User Context]\np\n[/User Context]',
      project: { id: 'cortex', contextDir: '/ctx' },
      commission: ACTIVE,
      preamble: 'PREAMBLE',
      resumed: true,
    }),
    'next step',
  );
});

test('resumed still keeps the lead and the appendix — those are this turn\'s content, not bootstrap', () => {
  assert.equal(
    composeUserPrompt({ directive: 'D', promptTemplate: '{{input}}' }, 'next', {
      lead: 'LEAD', appendix: '\n\n---\n\nAPPENDIX', resumed: true,
    }),
    'LEAD\n\n---\n\nnext\n\n---\n\nAPPENDIX',
  );
});
