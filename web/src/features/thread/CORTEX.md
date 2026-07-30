Please update me when files in this folder change

Desktop thread detail modal with expandable step chats, subthread switching, and inline artifact Markdown.
The AppShell-level provider opens details without changing browser navigation.

| filename | role | function |
|---|---|---|
| ThreadDetailModal.tsx | provider | Opens and controls the global detail modal |
| ThreadDetailView.tsx | view | Renders detail header, metadata, and columns |
| ThreadPipeline.tsx | view | Expands step chats and opens subthreads |
| ThreadStepChat.tsx | view | Renders a step session with live tail |
| ThreadArtifactPanel.tsx | view | Shows references and wrapping Markdown content |
| thread-detail-vm.ts | vm | Builds pipeline, metadata, and artifact slots |
| thread-detail-vm.test.ts | test | Tests desktop thread detail derivations |
| thread-detail-modal.test.ts | test | Tests modal open, switch, and close state |
| thread-detail-presentation.test.tsx | test | Tests detail copy, rendering, and overflow containment |
| nested-threads.ts | vm | Computes subthread level and tree depth |
| nested-threads.test.ts | test | Tests subthread nesting calculations |
| thread-steps.ts | util | Selects runs belonging to one step |
| thread-steps.test.ts | test | Tests step run selection |
| useThreadGetLiveSync.ts | hook | Refetches light or artifact-bearing detail |
