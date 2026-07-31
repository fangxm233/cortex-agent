Please update me when files in this folder change

Lifecycle-grouped complete task list used by both the tasks route and workbench task tab.
An AppShell provider opens details with dependencies, evidence, dispatch history and actions.

| filename | role | function |
|---|---|---|
| TasksPage.tsx | entry | Tasks route page wrapping the tasks panel |
| TasksPanel.tsx | core | Complete six-group task list with modal links |
| TaskRow.tsx | view | Renders one clickable lifecycle-aware task card |
| TaskRow.test.tsx | test | Tests card metadata and inert-control absence |
| TaskModal.tsx | view | Task detail modal with fields, deps and actions |
| TaskModalProvider.tsx | provider | Opens project-scoped task details globally |
| TaskModalProvider.test.ts | test | Tests modal selection state transitions |
| task-modal-vm.ts | vm | Builds approval and claim-aware detail state |
| task-modal-vm.test.ts | test | Guards approval, claim, fields and actions |
| group-tasks.ts | vm | Groups tasks into six lifecycle sections |
| group-tasks.test.ts | test | Tests lifecycle grouping and open counts |
| task-claim.ts | util | Selects the safe UI claim identifier |
| task-dependencies.ts | util | Resolves unmet dependency ids for task views |
| task-verification-vm.ts | vm | Builds completion evidence and dispatch rows |
| task-verification-vm.test.ts | test | Unit tests for the verification view model |
| useTasksLiveSync.ts | hook | Refetches tasks on lifecycle and thread links |
