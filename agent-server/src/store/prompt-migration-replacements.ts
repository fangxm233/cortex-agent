// input:  Legacy coder-reviewer directive text
// output: Commit-policy prompt replacement table
// pos:    Defines the coder-review commit-policy migration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

const REVIEWER_HANDOFF_BOUNDARY = '- Commits must land **before** the handoff boundary (before downstream consumers run it, before QA reviews, before the thread ends). Uncommitted changes at handoff are **Blockers**.';
const REVIEWER_COMMIT_RULES = [
  "- Attribute the implementation from the summary/artifact's explicit SHA evidence and verify the commit and diff with Git. Missing or unverifiable attribution is a **Blocker**.",
  '- Commit subjects should reference the spec identifier when repository policy permits; omission is a **Nice-to-have** in that case. When repository policy forbids internal or context identifiers, their omission is compliant, must not be treated as a Blocker, and must not require a metadata-only follow-up commit.',
].join('\n');
const REVIEWER_COMMIT_PROCEDURE = "Verify implementation attribution from the summary/artifact's explicit SHA evidence and Git history, then assess subject references under repository policy.";

export const CODER_REVIEWER_COMMIT_POLICY_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    '- `git log` shows at least one commit attributable to this invocation.',
    '- The implementation summary/artifact identifies at least one commit attributable to this invocation, and Git can verify it.',
  ],
  [
    '- Commits must land **before** the handoff boundary (before Engineer launches, before QA reviews, before the thread ends). Uncommitted changes at handoff are **Blockers**.',
    REVIEWER_HANDOFF_BOUNDARY,
  ],
  [
    '- Commit message should reference the spec identifier (task ID, issue reference) when one is clearly available; missing reference is a **Nice-to-have**.',
    REVIEWER_COMMIT_RULES,
  ],
  [
    '- Commit message must reference the spec identifier (EXP ID, task ID, issue reference). Missing reference is a **Blocker** in research mode; **Nice-to-have** in generic mode unless a task ID was clearly available.',
    REVIEWER_COMMIT_RULES,
  ],
  ['7. Check commit messages for spec-identifier references.', `7. ${REVIEWER_COMMIT_PROCEDURE}`],
  ['6. Check commit messages for spec-identifier references.', `6. ${REVIEWER_COMMIT_PROCEDURE}`],
  [
    '- **Drift you must catch for Coder**: spec improvisation, logic bugs and poor error handling in the diff, post-handoff commits, missing spec-identifier reference in commits, `--no-verify` bypass, runtime-only config.',
    '- **Drift you must catch for Coder**: spec improvisation, logic bugs and poor error handling in the diff, post-handoff commits, `--no-verify` bypass, runtime-only config.',
  ],
];
