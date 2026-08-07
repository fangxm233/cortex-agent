Please update me when files in this folder change

Managed hook scripts deployed into the runtime hook directory.

| filename | role | function |
|---|---|---|
| ask-user-question-hook.mjs | bridge | Routes agent questions through the webhook |
| cortex-hook-api.mjs | library | askUser helper for hook scripts |
| cortex-md-injector.mjs | context | Injects matching directory context |
| exit-plan-mode-hook.mjs | bridge | Routes plan approval through the webhook |
| memory-ref-tracker.mjs | tracker | Records memory reference reads |
| new-session-hook.mjs | session | Builds the new-session flush prompt |
| post-task-hook.mjs | thread | Builds the template completion prompt |
| rules-loader.mjs | loader | Loads matching rules after file reads |
| session-activity-tracker.mjs | tracker | Records session tool activity |
| status-md-guard.mjs | guard | Enforces STATUS.md register size caps |
| task-status-check.mjs | thread | Checks dispatched task state at thread end |
| tasks-yaml-guard.mjs | guard | Protects task queue edits |
