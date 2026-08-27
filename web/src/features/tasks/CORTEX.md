Please update me when files in this folder change

Lifecycle-grouped task list and canonical locale/CSS-free detail facts used by desktop and mobile.
Grouping, status, claim, dependency, completion and dispatch semantics are shared; final views stay platform-specific.

| filename | role | function |
|---|---|---|
| TasksPage.tsx | entry | Tasks route page wrapping the tasks panel |
| TasksPanel.tsx | core | Complete six-group task list with modal links |
| TaskRow.tsx | view | Renders task cards with one-line blocker details |
| TaskModal.tsx | view | Adapts verification data into the desktop detail modal, fields and actions |
| TaskModalProvider.tsx | provider | Opens project-scoped task details globally |
| TaskModalProvider.test.ts | test | Tests modal selection state transitions |
| task-detail-facts.ts | model | Normalizes status, claim, completion, dependency graph and newest-first verification facts |
| task-detail-facts.test.ts | test | Specifies shared locale/CSS-free detail precedence, joins and dispatch ordering |
| task-modal-vm.ts | vm | Projects shared facts into desktop approval fields, theme slots and action guards |
| task-modal-vm.test.ts | test | Guards persisted state, approval, claim, completion precedence, dependencies and actions |
| group-tasks.ts | vm | Canonically groups desktop/mobile tasks into six ordered sections, done newest-first |
| group-tasks.test.ts | test | Tests shared precedence, dependency semantics, group order, done order and open counts |
| task-claim.ts | util | Selects the safe UI claim identifier |
| task-dependencies.ts | util | Resolves unmet dependency ids for task views |
| task-time.ts | util | Formats completion timestamps in local time |
| task-verification-vm.ts | vm | Projects shared verification facts into themed, formatted desktop dispatch rows |
| task-verification-vm.test.ts | test | Tests honest evidence, newest-first rows and completing-execution mapping |
| useTasksLiveSync.ts | hook | Refetches tasks on lifecycle and thread links |
