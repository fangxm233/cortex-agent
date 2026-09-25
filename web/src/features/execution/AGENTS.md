Please update me when files in this folder change.

Execution presentation and supporting state modules.

| filename | role | function |
|---|---|---|
| ExecutionDrawer.tsx | view | The drawer container: execution queries, kill action, opaque status chrome |
| ExecutionDrawerView.tsx | view | Hooks-free drawer presentation: stable log and highlighted toolbar |
| ExecutionDrawerView.test.tsx | test | Verify log contrast and accessible actions |
| execution-drawer-view.ts | model | Map an execution to drawer title, pill, meta and notice |
| execution-drawer-view.test.ts | test | Verify the drawer view-model |
| useExecutionDrawer.tsx | adapter | Modal-registry key, `useExecutionDrawer()` opener and the drawer's host |
