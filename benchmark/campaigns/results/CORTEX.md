Update this file whenever this directory changes

Committed campaign result summaries preserve path-sanitized reproducibility evidence without runtime artifacts or credentials.

| filename | role | function |
|---|---|---|
| terminal-bench-2.1-deepseek-paid-2026-08-13.json | evidence | Records the stopped r1 paid attempt, first-trial timeout evidence, exact accounting and unattempted tasks |
| terminal-bench-2.1-deepseek-paid-r3-2026-08-13.json | evidence | Records the sole r3 attempt, first-trial inner-terminal rejection, exact paid accounting and unattempted tasks |
| terminal-bench-2.1-deepseek-paid-r4-2026-08-13.json | evidence | Records the r4 attempt, its first-trial agent-phase timeout, why the agent did not finish, and the timeout separation that followed |
| terminal-bench-2.1-deepseek-paid-r5-2026-08-13.json | evidence | Records the first concurrent paid campaign, its three distinct trial failures, and the four defects they exposed including the cached-token pricing disagreement |
| terminal-bench-2.1-deepseek-paid-r7-2026-08-15.json | evidence | Records the first campaign to produce a Terminal-Bench score (1/3), the artifact-provenance gate that refused its first launch, and the deadline-misclassification and tool-hang defects behind the two zeros |
| terminal-bench-2.1-deepseek-paid-r8-2026-08-18.json | evidence | Records the one approved production-direct rerun, raw verifier score 2/3 versus r7's 1/3, per-task cost/latency/requests, and the unchanged leak scan that blocked every outer envelope and forbids an unapproved retry |
| terminal-bench-2.1-vendor-pi-staged-2026-08-19.json | evidence | Records the one bounded vendor-PI staged attempt stopping at handshake setup failure, zero provider requests, post-failure leak/revocation evidence, and the unstarted later stages |
| terminal-bench-2.1-vendor-pi-comparison-2026-08-19.json | report | Records that no vendor-PI task comparison is available because the mandatory staged stop prevented both score-producing campaigns |
| terminal-bench-2.1-vendor-pi-3ff0-2026-08-19.json | evidence | Records task 3ff0's vendor-native one-request handshake rejection, proxy/leak/revocation evidence, and permanent staged stop |
| terminal-bench-2.1-vendor-pi-3ff0-comparison-2026-08-19.json | report | Records that task 3ff0 produced no vendor score because the real-relay handshake gate failed before stages 2 and 3 |
| terminal-bench-2.1-vendor-codex-staged-2026-08-19.json | evidence | Records the first one-request handshake failure, version drift checks, clean scan, revocation path and staged stop |
| terminal-bench-2.1-vendor-codex-comparison-2026-08-19.json | report | Records no comparison because the first stage-1 request prevented promotion and both campaigns |
| terminal-bench-2.1-vendor-codex-staged-r2-2026-08-20.json | evidence | Records the final one-request HTTP 400 model rejection, redacted response, clean scan, revocation and permanent Codex stop |
| terminal-bench-2.1-vendor-codex-comparison-r2-2026-08-20.json | report | Records no Codex comparison because the final stage-1 request failed before promotion and both campaigns |
| terminal-bench-2.1-vendor-claude-staged-2026-08-20.json | evidence | Records the sole Claude handshake HTTP 429, clean scan, revocation proof and permanent staged stop |
| terminal-bench-2.1-vendor-claude-comparison-2026-08-20.json | report | Records no comparison because stage 1 prevented promotion and both campaigns |
| zero-paid-dry-run-2026-08-13.json | evidence | Records the accepted two-trial ZERO-PAID campaign hashes, counts and safety facts |
| zero-paid-failed-agent-2026-08-13.json | evidence | Records the ZERO-PAID run proving a failed agent is published, scored 0 by its own verifier, followed by the next trial, and that each trial carries its own witnessed asset record instead of the bundle |
| zero-paid-parallel-2026-08-13.json | evidence | Records the ZERO-PAID run proving concurrent trials hold distinct subnets, container addresses and live routes, that a slot is exclusive and reusable, and that every per-trial gate still holds |
| zero-paid-production-direct-leakfix-2026-08-18.json | evidence | Records the clean production-direct envelope after safe container-root alias classification |
