Please update me when files in this folder change

Lifecycle-grouped complete task list used by desktop and mobile task surfaces.
Its canonical grouping/order model also feeds the workbench tab; details retain platform-specific views.

| filename | role | function |
|---|---|---|
| TasksPage.tsx | entry | Tasks route page wrapping the tasks panel |
| TasksPanel.tsx | core | Complete six-group task list with modal links |
| TaskRow.tsx | view | Renders task cards with one-line blocker details |
| TaskModal.tsx | view | Task detail modal with blocker, fields and actions |
| TaskModalProvider.tsx | provider | Opens project-scoped task details globally |
| TaskModalProvider.test.ts | test | Tests modal selection state transitions |
| task-modal-vm.ts | vm | Builds approval and claim-aware detail state |
| task-modal-vm.test.ts | test | Guards persisted state, approval, claim, dependencies and actions |
| group-tasks.ts | vm | Canonically groups desktop/mobile tasks into six ordered sections, done newest-first |
| group-tasks.test.ts | test | Tests shared precedence, dependency semantics, group order, done order and open counts |
| task-claim.ts | util | Selects the safe UI claim identifier |
| task-dependencies.ts | util | Resolves unmet dependency ids for task views |
| task-time.ts | util | Formats completion timestamps in local time |
| task-verification-vm.ts | vm | Builds completion evidence and dispatch rows |
| task-verification-vm.test.ts | test | Tests verification evidence and completing-dispatch mapping |
| useTasksLiveSync.ts | hook | Refetches tasks on lifecycle and thread links |
