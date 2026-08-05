// input:  the two authored reviewer-fix documents and the stock coder-review stack beside them
// output: the frozen field tables and the ten non-inheritance predicates, each proved discriminating
// pos:    Authored-not-copied proof for the reviewer-fix template and its fixing agent
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. Every static predicate below is paired with the same predicate run against the stock
// `coder-review` document it is meant to exclude, so a check that would pass for a byte copy fails
// here loudly. The two runtime predicates cross a real seam: the whitelist is resolved by the
// shipped capability derivation against the shipped defaults directory, and the lifecycle-hook
// assertion reads the deps object the orchestrator's own factory installs.

import '../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';

import { DEFAULTS_DIR } from '../../../src/core/paths.js';
import { childTemplateWhitelistForArm } from '../../../src/domain/benchmark/capabilities.js';
import { createLocalThreadRuntimeDeps } from '../../../src/domain/threads/local-runtime-deps.js';
import { executeLifecycleHooks } from '../../../src/domain/threads/hook-runner.js';
import { runThread } from '../../../src/domain/threads/runner.js';

const SHIPPED = path.join(DEFAULTS_DIR, 'config', 'thread-templates');
const TEMPLATE = 'benchmark-coder-review-fix';
const FIXER = 'benchmark-fixer';

/** (14.1.5) verbatim. These are the bytes; a difference here is a re-decision, not a typo. */
const S_FIX = 'You are an implementation auditor operating in an isolated benchmark task workspace. You are the last stage of this pipeline: audit the implementation, and fix the blockers you confirm rather than reporting them. Keep every fix minimal and scoped to the blocker that motivated it. The workspace may not be a git repository and may have no repository-wide test command; verify only the behavior you changed.';

const D_FIX = 'You are the benchmark fixing reviewer. Independently inspect the current task workspace, verify the implementation against the task, and directly fix every blocker you can confirm with evidence. Work in place in the current workspace. Do not assume git, commits, a repository-wide test command, or any task-tracking system exists, and do not attempt to use one.';

const P_FIX = 'Original task:\n{{input}}\n\nRead {{artifactPath}} for the coder\'s implementation handoff, then inspect the current task workspace yourself and verify the implementation against the task. Re-check each candidate blocker against the workspace before acting on it. Fix every blocker you confirm, directly and in place, keeping each fix minimal and scoped to that blocker; run targeted verification for each behavior you change. Do not assume git, commits, or a repository-wide test command exists. When finished, append a terminal review to {{artifactPath}} listing each issue with its evidence and its disposition — fixed, or left open with the reason. If every blocker you found is now fixed and verified, end your message with the exact token [FIX-VERIFIED]; if any blocker remains open, do not write that token anywhere. This is the final stage: nothing runs after you.';

/**
 * NI2/NI3 are polarity predicates, not vocabulary bans: a document cannot forbid assuming git
 * without naming git, and `plan:20` bans the assumption. The closed list is (14.1.5)'s three
 * authored negation clauses; an occurrence outside it fails, which is the friction worth having.
 * The original substring form was unsatisfiable against NI4's own mandated literal and was
 * corrected in the contract by the `6449` manager (design commit `c4da29c5`).
 */
const NEGATION_CLAUSES = [
  'may not be a git repository',
  'Do not assume git, commits, a repository-wide test command, or any task-tracking system exists',
  'Do not assume git, commits, or a repository-wide test command exists',
];

function documentText(kind: 'agents' | 'templates', name: string): string {
  return fs.readFileSync(path.join(SHIPPED, kind, `${name}.json`), 'utf8');
}

function documentOf(kind: 'agents' | 'templates', name: string): any {
  return JSON.parse(documentText(kind, name));
}

/** Byte ranges the closed list occupies in this text, so an occurrence can be located inside one. */
function negationRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const clause of NEGATION_CLAUSES) {
    let from = text.indexOf(clause);
    while (from !== -1) {
      ranges.push({ start: from, end: from + clause.length });
      from = text.indexOf(clause, from + 1);
    }
  }
  return ranges;
}

/** Every case-insensitive occurrence of `word` that does NOT fall inside an authored negation. */
function occurrencesOutsideNegations(text: string, word: string): string[] {
  const ranges = negationRanges(text);
  const stray: string[] = [];
  const pattern = new RegExp(word, 'gi');
  for (const match of text.matchAll(pattern)) {
    const at = match.index!;
    const inside = ranges.some(range => at >= range.start && at + word.length <= range.end);
    if (!inside) stray.push(text.slice(Math.max(0, at - 40), at + 40));
  }
  return stray;
}

const newDocuments = (): { label: string; text: string }[] => [
  { label: `templates/${TEMPLATE}`, text: documentText('templates', TEMPLATE) },
  { label: `agents/${FIXER}`, text: documentText('agents', FIXER) },
];

const stockDocuments = (): { label: string; text: string }[] => [
  { label: 'templates/coder-review', text: documentText('templates', 'coder-review') },
  { label: 'agents/coder-reviewer', text: documentText('agents', 'coder-reviewer') },
  { label: 'agents/coder', text: documentText('agents', 'coder') },
];

function stockHookScript(): string {
  return fs.readFileSync(path.join(DEFAULTS_DIR, 'hooks', 'post-task-hook.mjs'), 'utf8');
}

// ---------------------------------------------------------------- TA3, the template document

it('TA3: the template document carries exactly the eight frozen fields', () => {
  const template = documentOf('templates', TEMPLATE);

  assert.deepEqual(Object.keys(template).sort(), [
    'agents', 'description', 'disableHooks', 'entryAgent', 'entryStage', 'maxTotalSteps',
    'name', 'transitions',
  ]);
  assert.equal(template.name, TEMPLATE);
  assert.equal(
    template.description,
    'Hook-free benchmark loop: coder implement, then an independent reviewer that audits and '
    + 'directly fixes blockers in the shared writable workspace',
  );
  assert.deepEqual(template.agents, ['benchmark-coder', FIXER]);
  assert.deepEqual(template.transitions, [{
    from: 'benchmark-coder:implement', to: `${FIXER}:auditFix`, condition: { type: 'always' },
  }]);
  assert.equal(template.entryAgent, 'benchmark-coder');
  assert.equal(template.entryStage, 'implement');
  // Two stages made structural: a budget above the stage count admits a stage set C4 forbids, and
  // the stock template's slack of 4 is exactly what is not inherited.
  assert.equal(template.maxTotalSteps, 2);
  assert.equal(documentOf('templates', 'coder-review').maxTotalSteps, 4);
  assert.equal(template.disableHooks, true);
});

it('TA3: the single transition is unconditional, so no third stage is reachable', () => {
  const template = documentOf('templates', TEMPLATE);

  assert.equal(template.transitions.length, 1);
  // A convergence or output_contains condition would give the two-stage variant a retry edge and
  // would additionally let one variant's marker satisfy the other's contract.
  assert.equal(template.transitions[0].condition.type, 'always');
  const text = documentText('templates', TEMPLATE);
  assert.equal(text.includes('convergence'), false, text);
  assert.equal(text.includes('[IMPL-APPROVED]'), false, text);
  assert.equal(text.includes('maxIterations'), false, text);
  // The sibling variant is the contrast: it has the convergence edge this one must not have.
  const sibling = documentText('templates', 'benchmark-coder-review');
  assert.ok(sibling.includes('convergence') && sibling.includes('[IMPL-APPROVED]'));
});

// ---------------------------------------------------------------- TA4, the agent document

it('TA4: the fixer agent document carries exactly the frozen field table', () => {
  const fixer = documentOf('agents', FIXER);

  assert.deepEqual(Object.keys(fixer).sort(), [
    'description', 'directive', 'entryStage', 'mcpComposition', 'name', 'persistSession',
    'profile', 'stages', 'systemPrompt', 'tools',
  ]);
  assert.equal(fixer.name, FIXER);
  assert.equal(
    fixer.description,
    'Benchmark Fixer — independently audits the task-workspace implementation and directly fixes '
    + 'the blockers it finds',
  );
  assert.equal(fixer.profile, '__active__');
  assert.equal(fixer.persistSession, true);
  assert.equal(fixer.entryStage, 'auditFix');
  assert.equal(fixer.mcpComposition, 'none');
  assert.deepEqual(Object.keys(fixer.stages), ['auditFix']);
  assert.deepEqual(Object.keys(fixer.stages.auditFix).sort(), ['description', 'promptTemplate']);
  // A fresh session is what `plan:17`'s "independent" buys, so the stage may not continue one.
  assert.equal('continuesSession' in fixer.stages.auditFix, false);
  assert.equal(
    fixer.stages.auditFix.description,
    'Audit the implementation, fix confirmed blockers in place, and record the terminal review.',
  );
});

it('(14.1.5): the three authored prompt assets are byte-identical to the frozen literals', () => {
  const fixer = documentOf('agents', FIXER);

  assert.equal(fixer.systemPrompt, S_FIX);
  assert.equal(fixer.directive, D_FIX);
  assert.equal(fixer.stages.auditFix.promptTemplate, P_FIX);
  // The verdict token is the last thing in the message, so the proposal's read is a suffix test
  // rather than a scan of prose that may quote the token while discussing it.
  assert.ok(P_FIX.includes('end your message with the exact token [FIX-VERIFIED]'));
  // The prompts are authored, not loaded from the stock role files the stock agent points at.
  assert.equal(String(fixer.directive).startsWith('file:'), false);
  assert.equal(String(fixer.systemPrompt).startsWith('file:'), false);
  const stock = documentOf('agents', 'coder-reviewer');
  assert.ok(String(stock.directive).startsWith('file:') || String(stock.systemPrompt).startsWith('file:'));
});

// ---------------------------------------------------------------- NI1–NI10

it('NI1: the template declares no hooks key, and the local thread emits none at the seam', async () => {
  const template = documentOf('templates', TEMPLATE);
  assert.equal('hooks' in template, false);
  assert.equal(documentText('templates', TEMPLATE).includes('onEnd'), false);
  // Discriminating: the stock document carries exactly the onEnd hook this one must not inherit,
  // and its command is a host path under ~/.cortex that does not exist inside a trial container.
  const stock = documentOf('templates', 'coder-review');
  assert.equal(stock.hooks.onEnd.command, 'node ~/.cortex/hooks/post-task-hook.mjs');

  // The runtime half: the deps the benchmark orchestrator installs carry a no-op emitter, so the
  // absence is proved at the seam and not only in the document.
  const deps = createLocalThreadRuntimeDeps(runThread);
  assert.notEqual(deps.emitLifecycleHooks, executeLifecycleHooks);
  assert.equal(await deps.emitLifecycleHooks('thread-1', 'end', {} as any, {} as any), undefined);
});

it('NI2/NI3: git, commits and SHAs appear only inside the authored negation clauses', () => {
  for (const document of newDocuments()) {
    assert.deepEqual(occurrencesOutsideNegations(document.text, 'git'), [], document.label);
    assert.deepEqual(occurrencesOutsideNegations(document.text, 'commit'), [], document.label);
    assert.equal(document.text.includes('SHA'), false, document.label);
  }
  // Discriminating: every stock document that mentions git or a commit does so OUTSIDE any
  // negation, which is precisely the assumption `plan:20` forbids inheriting.
  const stray = stockDocuments()
    .flatMap(document => [
      ...occurrencesOutsideNegations(document.text, 'git'),
      ...occurrencesOutsideNegations(document.text, 'commit'),
    ]);
  assert.ok(stray.length > 0, 'the stock stack must fail the predicate the new documents pass');
  assert.ok(occurrencesOutsideNegations(stockHookScript(), 'git status').length > 0);
});

it('NI4: neither new document inherits a whole-repository test command', () => {
  for (const document of newDocuments()) {
    assert.equal(document.text.includes('npm test'), false, document.label);
    assert.equal(document.text.includes('full test suite'), false, document.label);
    assert.equal(document.text.includes('test suite'), false, document.label);
  }
  assert.ok(P_FIX.includes('Do not assume git, commits, or a repository-wide test command exists'));
  // Discriminating: the stock reviewer demands exactly that command, by name.
  const stock = documentText('agents', 'coder-reviewer');
  assert.ok(stock.includes('full test suite') && stock.includes('npm test'));
});

it('NI5: neither new document inherits worktree integration or a push', () => {
  for (const document of newDocuments()) {
    for (const word of ['worktree', 'push', 'branch']) {
      assert.equal(document.text.includes(word), false, `${document.label}: ${word}`);
    }
  }
  // Discriminating: the text lives in the hook NI1 removes, so this assumption travels with NI1.
  const hook = stockHookScript();
  assert.ok(hook.includes('worktree') && hook.includes('branch') && hook.includes('push'));
});

it('NI6: neither new document inherits host Cortex task state', () => {
  for (const document of newDocuments()) {
    for (const word of ['CORTEX_TASK_ID', 'cortex-task', 'done_when']) {
      assert.equal(document.text.includes(word), false, `${document.label}: ${word}`);
    }
  }
  // The fixer is told the class of thing does not exist, rather than being told nothing about it.
  assert.ok(D_FIX.includes('or any task-tracking system exists, and do not attempt to use one'));
  // Discriminating: the stock reviewer owns the host task's final lifecycle transition.
  const stock = documentText('agents', 'coder-reviewer');
  assert.ok(stock.includes('CORTEX_TASK_ID') && stock.includes('cortex-task'));
});

it('NI7: the fixer declares no host plugin directory', () => {
  const fixer = documentOf('agents', FIXER);
  assert.equal('pluginDirs' in fixer, false);
  // Discriminating: the stock reviewer reaches host skills, which enlarge its role-surface hash.
  assert.deepEqual(documentOf('agents', 'coder-reviewer').pluginDirs, [
    'plugins/cortex-common', 'plugins/cortex-coder',
  ]);
});

it('NI8: the fixer holds the benchmark coder surface and not the stock one', () => {
  const fixer = documentOf('agents', FIXER);
  const coder = documentOf('agents', 'benchmark-coder');

  // Derived, not chosen: the fixer does the coder's kind of work, so it holds the coder's surface.
  assert.equal(fixer.tools, coder.tools);
  assert.deepEqual(String(fixer.tools).split(','), [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Skill',
  ]);
  for (const name of ['Agent', 'TaskStop', 'WebFetch', 'WebSearch']) {
    assert.equal(String(fixer.tools).split(',').includes(name), false, name);
  }
  // Write and Edit are what make it a fixer, and are exactly what the audit-retry reviewer lost.
  // Split rather than substring-matched, because `TodoWrite` contains `Write`.
  const fixerNames = String(fixer.tools).split(',');
  assert.ok(fixerNames.includes('Write') && fixerNames.includes('Edit'));
  const reviewerNames = String(documentOf('agents', 'benchmark-reviewer').tools).split(',');
  assert.equal(reviewerNames.includes('Write'), false);
  assert.equal(reviewerNames.includes('Edit'), false);
  // Discriminating: the stock reviewer carries all four removed names.
  const stock = String(documentOf('agents', 'coder-reviewer').tools).split(',');
  for (const name of ['Agent', 'TaskStop', 'WebFetch', 'WebSearch']) assert.ok(stock.includes(name));
});

it('NI9: the fixer selects no named host profile', () => {
  assert.equal(documentOf('agents', FIXER).profile, '__active__');
  // Discriminating: the stock pair each pick a host profile a trial may not let them select.
  assert.equal(documentOf('agents', 'coder-reviewer').profile, 'execute');
  assert.equal(documentOf('agents', 'coder').profile, 'plan');
});

it('NI10: the template disables hooks in its own document, not only at runtime', () => {
  // A document that relies on the runtime forcing is a document that is wrong on any other path.
  assert.equal(documentOf('templates', TEMPLATE).disableHooks, true);
  // Discriminating: the stock template declares no such key and therefore runs with hooks live.
  assert.equal('disableHooks' in documentOf('templates', 'coder-review'), false);
});

// ---------------------------------------------------------------- the whitelist it closes

it('closes the shipped whitelist: the named template file now exists', () => {
  const arm: any = {
    schema_version: 'cortex-benchmark-arm/2', kind: 'cortex', name: 'cortex-claude-reviewer-fix',
    orchestration: { mode: 'coder-review', coder_review_variant: 'reviewer-fix', ask_manager: false },
  };

  const whitelist = childTemplateWhitelistForArm(arm);

  assert.deepEqual(whitelist, [TEMPLATE]);
  for (const name of whitelist) {
    assert.ok(fs.existsSync(path.join(SHIPPED, 'templates', `${name}.json`)), name);
  }
  // Every agent that template names resolves to a shipped document too, which is the other half
  // of the whitelist the compiler freezes.
  for (const agent of documentOf('templates', TEMPLATE).agents) {
    assert.ok(fs.existsSync(path.join(SHIPPED, 'agents', `${agent}.json`)), agent);
  }
});
