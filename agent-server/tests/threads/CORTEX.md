Please update me when files in this folder change

Regression tests for the thread domain: config and template loading, shell
expansion, step lifecycle, provider-outage recovery, and transcripts.

| filename | role | function |
|---|---|---|
| domain-threads-smoke.test.ts | test | Covers thread target, stage and var helpers |
| resolve-template-profiles.test.ts | test | Covers template to profile resolution |
| shell-template.test.ts | test | Covers shell binding expansion and errors |
| template-merge.test.ts | test | Covers merging defaults into user config |
| thread-config-dir.test.ts | test | Covers config directory load and migration |
| thread-live-step-ids.test.ts | test | Covers step session ids and thread events |
| thread-provider-outage.test.ts | test | Covers outage backoff, atomicity and concurrent cap |
| thread-rate-limit-resume.test.ts | test | Covers provider-attributed pause and resume |
| thread-transcript.test.ts | test | Covers step transcript ordering and content |
