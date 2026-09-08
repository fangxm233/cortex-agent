Please update me when files in this folder change

Regression tests for the thread domain: config and template loading, shell
expansion, step lifecycle, provider-outage recovery, and transcripts.

| filename | role | function |
|---|---|---|
| resolve-template-profiles.test.ts | test | Covers template to profile resolution |
| shell-template.test.ts | test | Covers shell expansion and shipped dependencies |
| shipped-prompts.test.ts | test | Covers role handoffs and manager checkpoints |
| template-merge.test.ts | test | Covers default merging and safe legacy-shell upgrades |
| thread-config-dir.test.ts | test | Covers config loading, gate overrides and migration |
| thread-config-watcher-fallback.test.ts | test | Covers polling and watcher registration races |
| thread-doc-review-retry.test.ts | test | Covers revised documents receiving a second review |
| thread-live-step-ids.test.ts | test | Covers step session ids and thread events |
| thread-provider-outage.test.ts | test | Covers outage backoff, cap and session reuse |
| thread-rate-limit-resume.test.ts | test | Covers provider-attributed pause and resume |
| thread-transcript.test.ts | test | Covers prompts, tool devices, ordering and notices |
