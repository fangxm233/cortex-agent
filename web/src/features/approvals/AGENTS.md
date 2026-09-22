Please update me when files in this folder change.

Approval queue state and desktop decision presentation.

| filename | role | function |
|---|---|---|
| ApprovalCenterModal.tsx | view | Display pending approvals and decision actions |
| ApprovalCenterModal.test.tsx | test | Verify overlay controls and queue handoff |
| approval-center-vm.ts | utility | Map approval entries to presentation models |
| approval-center-vm.test.ts | test | Verify approval presentation mapping |
| ApprovalsProvider.tsx | adapter | Provide shared approval modal entry point |
| useApprovalQueue.ts | adapter | Load approvals and submit queue decisions |
| useApprovalQueue.test.tsx | test | Verify queue loading and decision mutations |
