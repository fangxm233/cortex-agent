Please update me when files in this folder change

Lifecycle-grouped task list used by both the tasks route and the workbench tasks tab.
A detail modal shows fields, dependencies, completion evidence and dispatch history plus actions.

| filename | role | function |
|---|---|---|
| TasksPage.tsx | entry | Tasks route page wrapping the tasks panel |
| TasksPanel.tsx | core | Task list with Open/Recent/All scope and modal |
| TaskRow.tsx | view | One task card with lifecycle dot and metadata |
| TaskModal.tsx | view | Task detail modal with fields, deps and actions |
| task-modal-vm.ts | vm | Builds approval-aware fields, pill and deps |
| task-modal-vm.test.ts | test | Guards approval, fields, theme, deps and actions |
| group-tasks.ts | vm | Groups lifecycle and recent completed tasks |
| group-tasks.test.ts | test | Tests grouping, counts and recent completion |
| task-verification-vm.ts | vm | Builds completion evidence and dispatch rows |
| task-verification-vm.test.ts | test | Unit tests for the verification view model |
| useTasksLiveSync.ts | hook | Refetches the task list on lifecycle events |
