Please update me when files in this folder change

Shared approval ownership plus the desktop queue overlay for pending records in the approval file.
The headless queue unifies decision payloads and refresh; desktop retains selection, deny and toast UI.

| filename | role | function |
|---|---|---|
| ApprovalsProvider.tsx | provider | Mounts the modal and owns open and close state |
| ApprovalCenterModal.tsx | view | Owns desktop selection, armed deny, feedback and decision toasts |
| ApprovalCenterModal.test.tsx | test | Tests desktop feedback handoff, selection reset and reject toast |
| approval-center-vm.ts | vm | Maps approval records and shares structural default selection |
| approval-center-vm.test.ts | test | Tests payload mapping, command gating and layout-neutral selection |
| useApprovalQueue.ts | hook | Loads pending records and unifies approve/reject, trim, pending and invalidation |
| useApprovalQueue.test.tsx | test | Tests pending loading, decision payloads, pending state and list refresh |
