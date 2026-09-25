Please update me when files in this folder change

Managed declarative hooks shipped into the user hook registry.

| filename | role | function |
|---|---|---|
| 02-tasks-yaml-guard.json | guard | Protects task files on Claude and PI |
| 05-memory-ref-tracker.json | tracker | Tracks memory reference reads |
| 06-rules-loader.json | loader | Loads matching rules after reads |
| 07-session-activity-tracker.json | tracker | Records session tool activity |
| 08-agents-md-injector-post-tool.json | context | Injects directory context after tools |
| 10-agents-md-injector-session-start.json | context | Injects context at session start |
| 11-task-status-check.json | thread | Checks task state when dispatch threads end |
| 12-session-new-hook.json | session | Flushes memory before starting a new session |
| 13-status-md-guard.json | guard | Enforces STATUS.md register size caps |
