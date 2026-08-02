// input:  Legacy coder, reviewer, manager, worker and director prompt text
// output: Commit-policy, task-input and STATUS-register replacement tables
// pos:    Defines stock-text directive migrations
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

const REVIEWER_HANDOFF_BOUNDARY_BASE = '- Commits must land **before** the handoff boundary (before downstream consumers run it, before QA reviews, before the thread ends). Uncommitted changes at handoff are **Blockers**.';
const REVIEWER_HANDOFF_BOUNDARY = `${REVIEWER_HANDOFF_BOUNDARY_BASE} Your own fixes are held to the same rule: they are committed before you write the review artifact, and the artifact cites their SHAs.`;
const REVIEWER_COMMIT_RULES = [
  "- Attribute the implementation from the summary/artifact's explicit SHA evidence and verify the commit and diff with Git. Missing or unverifiable attribution is a **Blocker**.",
  '- Commit subjects should reference the spec identifier when repository policy permits; omission is a **Nice-to-have** in that case. When repository policy forbids internal or context identifiers, their omission is compliant, must not be treated as a Blocker, and must not require a metadata-only follow-up commit.',
].join('\n');
const REVIEWER_COMMIT_PROCEDURE = "Verify implementation attribution from the summary/artifact's explicit SHA evidence and Git history, then assess subject references under repository policy.";
const CODER_COMMIT_POLICY = 'Task/spec identifiers belong in commit subjects only when repository policy permits. Repository-local privacy rules take precedence; omission required by such a rule is compliant, and attribution must instead use the implementation SHA in the summary/artifact.';

export const CODER_COMMIT_POLICY_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    '- **Code commits**: your implementation committed to git with a clear message. Configuration is in-repo, not hardcoded at runtime. Commit message references the task / issue / ticket ID when available.',
    `- **Code commits**: your implementation committed to git with a clear message. Configuration is in-repo, not hardcoded at runtime. ${CODER_COMMIT_POLICY}`,
  ],
  [
    '- Use clear commit messages that reference the spec identifier (task ID, issue reference, plan section).',
    `- Use clear commit messages. ${CODER_COMMIT_POLICY}`,
  ],
  [
    '- Use clear commit messages that reference the spec identifier (EXP ID, task ID, issue reference).',
    `- Use clear commit messages. ${CODER_COMMIT_POLICY}`,
  ],
  [
    '- Git commit messages: concise, reference the spec identifier, describe what was implemented. No decorative language.',
    `- Git commit messages: concise and describe what was implemented. ${CODER_COMMIT_POLICY} No decorative language.`,
  ],
];

export const MANAGER_TASK_FILE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    '3. **Decompose via /manager-method** — the method (map the seams before cutting, the Cut-at-the-Seam Iron Rules, one-criterion-one-task with explicit dependencies, template selection by residual reasoning, and the per-child self-audit quality gate) lives in the skill (pointer below). After the method yields your children, create them in ONE call (exact recipe — write the JSON to a temp file first):',
    '3. **Decompose via /manager-method** — the method (map the seams before cutting, the Cut-at-the-Seam Iron Rules, one-criterion-one-task with explicit dependencies, template selection by residual reasoning, and the per-child self-audit quality gate) lives in the skill (pointer below). After the method yields your children, create them in ONE call. Use the Write tool—not shell redirection—to create `/tmp/subtasks-<your Task ID>.json` with this content:',
  ],
  [
    [
      '     ```bash',
      "     cat > /tmp/subtasks-<your Task ID>.json <<'JSON'",
      '     {"subtasks": [',
      '       {"key": "a", "text": "Create X", "done-when": "X exists and ...", "template": "execute-review"},',
      '       {"key": "b", "text": "Create Y", "done-when": "...", "template": "execute-review", "depends-on": ["a"]}',
      '     ]}',
      '     JSON',
      '     cortex-task decompose --project <project> --task-id <your Task ID> --keep-parent --auto-lock --subtasks-file /tmp/subtasks-<your Task ID>.json',
      '     ```',
    ].join('\n'),
    [
      '     ```json',
      '     [',
      '       {"key": "a", "text": "Create X", "done-when": "X exists and ...", "template": "execute-review"},',
      '       {"key": "b", "text": "Create Y", "done-when": "...", "template": "execute-review", "depends-on": ["a"]}',
      '     ]',
      '     ```',
      '',
      '     Then run `cortex-task decompose --project <project> --task-id <your Task ID> --keep-parent --auto-lock --subtasks-file /tmp/subtasks-<your Task ID>.json`.',
    ].join('\n'),
  ],
  [
    '1. Read the actual deliverable (code, files, experiment records) and check it against the child\'s done_when. Run tests where code is involved. Never accept a completion note as evidence. When the deliverable is substantial (files / code / a report / an experiment), prefer spawning an independent **verifier** child (`cortex-task spawn --text "Verify <deliverable> against: <done_when>" --template <review template>`) and consume only its verdict — an independent fresh-context check catches what your anchored read misses, and keeps large deliverables out of your own context.',
    '1. Read the actual deliverable (code, files, experiment records) and check it against the child\'s done_when. Run tests where code is involved. Never accept a completion note as evidence. When the deliverable is substantial (files / code / a report / an experiment), prefer spawning an independent **verifier** child: use the Write tool to stage its task JSON at `/tmp/cortex-task-<your Task ID>-<child-id>.json`, run `cortex-task spawn --task-file /tmp/cortex-task-<your Task ID>-<child-id>.json`, and consume only its verdict. An independent fresh-context check catches what your anchored read misses and keeps large deliverables out of your own context.',
  ],
  [
    '- For a quick sub-call that doesn\'t merit a full decomposition (an independent verifier pass on a child\'s deliverable, a short research probe before deciding a split), create a single child with `cortex-task spawn --text "..." --template <name>` (it hangs under you and joins via `depends_on`, like decompose) and then call `thread_wait`. It flows through the dispatch queue like any child — there is no in-process thread spawn (`thread_start` was removed; tasks are the only delegation primitive).',
    '- For a quick sub-call that doesn\'t merit a full decomposition (an independent verifier pass on a child\'s deliverable, a short research probe before deciding a split), use the Write tool to stage one child task JSON at `/tmp/cortex-task-<your Task ID>-<unique-id>.json`, run `cortex-task spawn --task-file /tmp/cortex-task-<your Task ID>-<unique-id>.json` (it hangs under you and joins via `depends_on`, like decompose), and then call `thread_wait`. It flows through the dispatch queue like any child — there is no in-process thread spawn (`thread_start` was removed; tasks are the only delegation primitive).',
  ],
  [
    '1. Read the actual deliverable (code, files, experiment records) and check it against the child\'s done_when. Run tests where code is involved. Never accept a completion note as evidence. When the deliverable is substantial (files / code / a report / an experiment), prefer spawning an independent **verifier** child: use the Write tool to stage its task JSON, run `cortex-task spawn --task-file <path>`, and consume only its verdict. An independent fresh-context check catches what your anchored read misses and keeps large deliverables out of your own context.',
    '1. Read the actual deliverable (code, files, experiment records) and check it against the child\'s done_when. Run tests where code is involved. Never accept a completion note as evidence. When the deliverable is substantial (files / code / a report / an experiment), prefer spawning an independent **verifier** child: use the Write tool to stage its task JSON at `/tmp/cortex-task-<your Task ID>-<child-id>.json`, run `cortex-task spawn --task-file /tmp/cortex-task-<your Task ID>-<child-id>.json`, and consume only its verdict. An independent fresh-context check catches what your anchored read misses and keeps large deliverables out of your own context.',
  ],
  [
    '- For a quick sub-call that doesn\'t merit a full decomposition (an independent verifier pass on a child\'s deliverable, a short research probe before deciding a split), use the Write tool to stage one child task JSON, run `cortex-task spawn --task-file <path>` (it hangs under you and joins via `depends_on`, like decompose), and then call `thread_wait`. It flows through the dispatch queue like any child — there is no in-process thread spawn (`thread_start` was removed; tasks are the only delegation primitive).',
    '- For a quick sub-call that doesn\'t merit a full decomposition (an independent verifier pass on a child\'s deliverable, a short research probe before deciding a split), use the Write tool to stage one child task JSON at `/tmp/cortex-task-<your Task ID>-<unique-id>.json`, run `cortex-task spawn --task-file /tmp/cortex-task-<your Task ID>-<unique-id>.json` (it hangs under you and joins via `depends_on`, like decompose), and then call `thread_wait`. It flows through the dispatch queue like any child — there is no in-process thread spawn (`thread_start` was removed; tasks are the only delegation primitive).',
  ],
];

// STATUS.md register semantics: stock prompts used to mandate unconditional
// STATUS.md updates and a `## Milestone Verdict` section; the register
// convention makes STATUS updates conditional on a situation change and moves
// verdict content into the gate artifact with a one-line pointer in STATUS.
// One shared table — pairs that don't match a given file are no-ops.
export const STATUS_REGISTER_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    "Record findings, decisions, and artifacts in files as you go — not in a final summary. Update STATUS.md, the directory's CORTEX.md index, and the role's designated output artifact(s) before exiting.",
    "Record findings, decisions, and artifacts in files as you go — not in a final summary. Update the role's designated output artifact(s) and the directory's CORTEX.md index before exiting. Update STATUS.md only if your work changed the project's situation (unblocked something, introduced a blocker, changed the next step) — STATUS is a state register, not a changelog; one line + pointer per change (see rules/status-md.md).",
  ],
  [
    "Prefer editing the existing project artifacts (STATUS.md, knowledge entries, the role's artifact file) over creating parallel new files.",
    "Prefer editing the existing project artifacts (the role's artifact file, knowledge entries, existing experiment records) over creating parallel new files.",
  ],
  [
    "7. Update the project's `STATUS.md`; record durable findings in the project knowledge files.",
    "7. Record durable findings in the project knowledge files. Update `STATUS.md` only if the delivered work changed the project's situation (unblocked something, introduced a blocker, changed the next step) — one line + pointer, not a completion report (see rules/status-md.md).",
  ],
  [
    '- **STATUS.md update**: append or replace a `## Milestone Verdict` section summarizing the verdict and the top 3 reasons. Include a timestamp and the milestone being judged.',
    '- **STATUS.md update**: one pointer line in the register (replacing any previous milestone line): `Milestone <N> gate (<ISO date>): <verdict> → <artifact path>`. The verdict, reasons, and analysis live only in the artifact — do not copy them into STATUS.md.',
  ],
  [
    '- Exactly one verdict in the artifact and in STATUS.md, and they match.',
    '- Exactly one verdict is stated, in the artifact (final line). STATUS.md carries a matching one-line pointer to the artifact, nothing more.',
  ],
  [
    [
      '- STATUS.md `## Milestone Verdict` section format:',
      '  ```',
      '  ## Milestone Verdict (<ISO date>, Milestone <N>: <name>)',
      '  Verdict: <one of four>',
      '  Top reasons:',
      '  - <reason 1 with citation>',
      '  - <reason 2 with citation>',
      '  - <reason 3 with citation>',
      '  Artifact: <relative path to artifact>',
      '  ```',
    ].join('\n'),
    [
      "- STATUS.md pointer line format (goes under the register's current-situation or blockers section, replacing any previous milestone line):",
      '  ```',
      '  Milestone <N> gate (<ISO date>): <verdict> → <artifact path>',
      '  ```',
    ].join('\n'),
  ],
];

export const CODER_REVIEWER_COMMIT_POLICY_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    '- `git log` shows at least one commit attributable to this invocation.',
    '- The implementation summary/artifact identifies at least one commit attributable to this invocation, and Git can verify it.',
  ],
  [
    '- Commits must land **before** the handoff boundary (before Engineer launches, before QA reviews, before the thread ends). Uncommitted changes at handoff are **Blockers**.',
    REVIEWER_HANDOFF_BOUNDARY,
  ],
  // Newline-anchored: the base sentence is a prefix of REVIEWER_HANDOFF_BOUNDARY, so an
  // unanchored pair would re-match its own output and append the clause on every run.
  [`${REVIEWER_HANDOFF_BOUNDARY_BASE}\n`, `${REVIEWER_HANDOFF_BOUNDARY}\n`],
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
