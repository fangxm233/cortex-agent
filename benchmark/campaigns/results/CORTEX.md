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
| zero-paid-dry-run-2026-08-13.json | evidence | Records the accepted two-trial ZERO-PAID campaign hashes, counts and safety facts |
| zero-paid-failed-agent-2026-08-13.json | evidence | Records the ZERO-PAID run proving a failed agent is published, scored 0 by its own verifier, followed by the next trial, and that each trial carries its own witnessed asset record instead of the bundle |
| zero-paid-parallel-2026-08-13.json | evidence | Records the ZERO-PAID run proving concurrent trials hold distinct subnets, container addresses and live routes, that a slot is exclusive and reusable, and that every per-trial gate still holds |
