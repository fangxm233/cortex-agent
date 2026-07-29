Please update me when files in this folder change

Managed hook scripts deployed into the runtime hook directory.

| filename | role | function |
|---|---|---|
| ask-user-question-hook.mjs | bridge | Routes agent questions through the webhook |
| cortex-md-injector.mjs | context | Injects matching directory context |
| exit-plan-mode-hook.mjs | bridge | Routes plan approval through the webhook |
| memory-ref-tracker.mjs | tracker | Records memory reference reads |
| new-session-hook.mjs | session | Builds the new-session flush prompt |
| post-task-hook.mjs | thread | Builds the template completion prompt |
| rules-loader.mjs | loader | Loads matching rules after file reads |
| sensitive-file-edit.mjs | guard | Handles protected configuration edits |
| session-activity-tracker.mjs | tracker | Records session tool activity |
| task-status-check.mjs | thread | Checks dispatched task state at thread end |
| tasks-yaml-guard.mjs | guard | Protects task queue edits |
