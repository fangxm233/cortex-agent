Please update me when files in this folder change

Canonical locale/CSS-free thread detail facts and resource controller shared by desktop and mobile.
Desktop keeps its expandable modal, subthread switching, copy, written-by trail, and inline artifact Markdown.

| filename | role | function |
|---|---|---|
| ThreadDetailModal.tsx | provider | Adapts the shared artifact-bearing controller into the global modal |
| ThreadDetailView.tsx | view | Renders detail header, metadata, and columns |
| ThreadPipeline.tsx | view | Expands step chats and opens subthreads |
| ThreadStepChat.tsx | view | Renders a compact step session with live tail and lazy subagent detail |
| ThreadArtifactPanel.tsx | view | Shows references and wrapping Markdown content |
| thread-detail-facts.ts | facts | Derives canonical live, timing, step, agent, dispatch, and depth facts |
| thread-detail-facts.test.ts | test | Tests cross-surface thread detail semantics |
| useThreadDetailController.ts | hook | Owns exact get mode, live tick, cancel, and cache invalidation |
| useThreadDetailController.test.tsx | test | Tests shared detail query and cancellation lifecycle |
| thread-detail-vm.ts | vm | Projects desktop copy, USD metadata, written-by, and artifact slots |
| thread-detail-vm.test.ts | test | Tests desktop thread detail projections |
| thread-detail-modal.test.ts | test | Tests modal open, switch, and close state |
| nested-threads.ts | vm | Supplies subthread levels and bounded depth calculation to shared facts |
| nested-threads.test.ts | test | Tests subthread nesting calculations |
| thread-steps.ts | util | Selects runs belonging to one step |
| thread-steps.test.ts | test | Tests step run selection |
| useThreadGetLiveSync.ts | hook | Refetches the selected light or artifact-bearing detail key |
