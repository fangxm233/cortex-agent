Please update me when files in this folder change

Shipped hook programs that enforce context, task, and session workflows.

| filename | role | function |
|---|---|---|
| ask-user-question-hook.mjs | hook | Forwards user questions to the platform |
| cortex-md-injector.mjs | hook | Injects ancestor CORTEX.md context |
| exit-plan-mode-hook.mjs | hook | Forwards plans for interactive approval |
| memory-ref-tracker.mjs | hook | Records memory entry references |
| new-session-hook.mjs | hook | Flushes session knowledge before reset |
| post-task-hook.mjs | hook | Runs configured post-task actions |
| rules-loader.mjs | hook | Loads path-scoped runtime rules |
| sensitive-file-edit.mjs | hook | Authorizes configured sensitive file edits |
| session-activity-tracker.mjs | hook | Records path-only session activity |
| task-status-check.mjs | hook | Checks task state after tool calls |
| tasks-yaml-guard.mjs | hook | Guards task queue edits with project locks |
