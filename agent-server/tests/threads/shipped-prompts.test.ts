// input:  Vitest, shipped agent definitions and prompt files
// output: Role handoff and manager checkpoint regressions
// pos:    Verifies compact prompts retain thread contracts
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULTS_DIR } from '../../src/core/paths.js';
import type { AgentDefinition } from '../../src/core/types/thread-types.js';

function agent(name: string): AgentDefinition {
  return JSON.parse(readFileSync(path.join(
    DEFAULTS_DIR, 'config/thread-templates/agents', `${name}.json`,
  ), 'utf8'));
}

function directive(name: string): string {
  return readFileSync(path.join(DEFAULTS_DIR, 'prompts/directives', `${name}.md`), 'utf8');
}

test('coder handoff keeps final task completion with the reviewer', () => {
  const implement = agent('coder').stages!.implement.promptTemplate;
  const review = agent('coder-reviewer').stages!.implReview.promptTemplate;
  assert.match(implement, /## Implementation Summary/);
  assert.match(implement, /do not run `cortex-task complete`/);
  assert.match(implement, /Leave it claimed for the final reviewer/);
  assert.match(review, /## Impl Review/);
  assert.match(review, /you alone own the task's final lifecycle transition/);
  assert.match(review, /every `done_when` condition and no Blocker remains/);
  assert.match(review, /## When Done/);
  assert.match(review, /block or unclaim/);
  assert.match(review, /{{modifiedFiles}}/);
});

for (const [worker, reviewer, firstStage, summary] of [
  ['doc-writer', 'doc-reviewer', 'write', 'Write Summary'],
  ['executor', 'executor-reviewer', 'execute', 'Execute Summary'],
] as const) {
  test(`${worker} keeps reviewer approval and revision markers`, () => {
    const stages = agent(worker).stages!;
    for (const stage of [firstStage, 'retry']) {
      assert.ok(stages[stage].promptTemplate.includes(`## ${summary}`));
      assert.match(stages[stage].promptTemplate, /Do not write `\[APPROVED\]`/);
      assert.match(stages[stage].promptTemplate, /{{artifactPath}}/);
    }
    assert.match(stages.retry.promptTemplate, /\[REVISED\].*on its own line/);
    const prompt = agent(reviewer).promptTemplate!;
    assert.match(prompt, /## Review \(iteration N\)/);
    assert.match(prompt, /\[APPROVED\].*only if no Blockers remain/);
    assert.match(directive(reviewer), /do not (rewrite|perform the fixes)/);
  });
}

test('manager retains parent linkage, checkpoint, wait, and acceptance', () => {
  const text = directive('manager');
  for (const term of ['decompose --keep-parent', 'delegations & acceptance criteria',
    'decisions made', 'remaining plan', 'assumptions', 'cortex-task verdict', 'done_when']) {
    assert.ok(text.includes(term), term);
  }
  assert.match(text, /update your artifact during the current step/);
  assert.match(text, /call `thread_wait` and end the step/);
  assert.match(text, /Do not poll/);
  assert.match(text, /check the integrated result/);
  assert.match(text, /two unsuccessful revision rounds/);
});

test('director retains the four verdicts without inventing one for missing evidence', () => {
  const prompt = agent('director').promptTemplate!;
  for (const verdict of ['Proceed', 'Iterate', 'Pivot', 'Abort']) {
    assert.ok(prompt.includes(`Verdict: ${verdict}`));
  }
  assert.match(prompt, /without inventing a verdict/);
  assert.match(directive('director'), /Proceed only when the criteria are satisfied/);
});
