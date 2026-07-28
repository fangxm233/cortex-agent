Please update me when files in this folder change

Regression tests for the ui-service facade behind the web API: query handlers, mutate handlers, and event subscriptions.
Scopes covered are approvals, config, executions, issues, memory, projects, schedules, sessions, tasks and threads.

| filename | role | function |
|---|---|---|
| mutate-approvals.test.ts | test | Covers approve, reject and request writes |
| mutate-config.test.ts | test | Covers budget and default profile writes |
| mutate-executions.test.ts | test | Covers execution cancellation outcomes |
| mutate-issues.test.ts | test | Covers issue delete and handoff to session |
| mutate-projects.test.ts | test | Covers project creation outcomes |
| mutate-schedules.test.ts | test | Covers schedule add, pause, resume, remove |
| mutate-sessions-cancel.test.ts | test | Covers session cancellation outcomes |
| mutate-sessions-create.test.ts | test | Covers session creation and default project |
| mutate-sessions-interactions.test.ts | test | Covers question answer and plan response |
| mutate-sessions-markread.test.ts | test | Covers session mark-read outcomes |
| mutate-sessions-rewind.test.ts | test | Covers session rewind guards and outcomes |
| mutate-sessions-send.test.ts | test | Covers session message send routing |
| mutate-sessions-set-profile.test.ts | test | Covers session profile switch outcomes |
| mutate-tasks.test.ts | test | Covers task lock acquire, release and force |
| mutate-threads.test.ts | test | Covers thread cancellation outcomes |
| query-approvals.test.ts | test | Covers approval queue parsing and listing |
| query-config.test.ts | test | Covers config snapshot and secret redaction |
| query-cost.test.ts | test | Covers cost summary and project filter |
| query-executions-get.test.ts | test | Covers execution detail lookup |
| query-executions.test.ts | test | Covers execution list filters and order |
| query-issues.test.ts | test | Covers issue markdown parsing and listing |
| query-memory.test.ts | test | Covers memory tree, file read and path guards |
| query-projects.test.ts | test | Covers project list with conduit info |
| query-schedules.test.ts | test | Covers schedule list filters and fields |
| query-sessions-transcript.test.ts | test | Covers transcript turns and interactions |
| query-sessions.test.ts | test | Covers session list filters and run state |
| query-skills.test.ts | test | Covers skills list grouping by source |
| query-system-rate-limit.test.ts | test | Covers rate-limit status windows |
| query-task-verification.test.ts | test | Covers task evidence and dispatch history |
| query-tasks.test.ts | test | Covers task list filters and fields |
| query-thread-detail.test.ts | test | Covers thread steps, runs and child tree |
| query-thread-templates.test.ts | test | Covers agent, template and shell listing |
| query-threads.test.ts | test | Covers thread list filters and step counts |
| subscribe-execution-log.test.ts | test | Covers log subscription and backpressure |
| subscribe.test.ts | test | Covers event subscription filters and close |
| tasks-integration.test.ts | test | Covers task lock cycle on a real store |
