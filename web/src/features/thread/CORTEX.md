Please update me when files in this folder change

Thread detail route showing one thread's execution from first step to final artifact.
A pipeline column lists steps with per-step chat and subthread drill-down; a side column holds the artifact.

| filename | role | function |
|---|---|---|
| ThreadDetailRoute.tsx | entry | Fetches the thread and frames the detail view |
| ThreadDetailView.tsx | view | Detail header, meta bar, pipeline and artifact |
| ThreadPipeline.tsx | view | Step list with one expanded step and subthreads |
| ThreadStepChat.tsx | view | Renders a step session as chat with live tail |
| ThreadArtifactPanel.tsx | view | Artifact card with references and author chips |
| thread-detail-vm.ts | vm | Builds detail steps, crumbs and artifact slots |
| thread-detail-vm.test.ts | test | Unit tests for the thread detail view model |
| nested-threads.ts | vm | Computes subthread display level and tree depth |
| nested-threads.test.ts | test | Unit tests for subthread nesting |
| thread-steps.ts | util | Selects the runs belonging to one step |
| thread-steps.test.ts | test | Unit tests for step run selection |
| useThreadGetLiveSync.ts | hook | Refetches detail on thread and task events |
