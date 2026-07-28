Please update me when files in this folder change

Desktop approval queue overlay: lists pending approvals read from the project approval file.
Approve or reject with feedback, then refresh the list from the server.

| filename | role | function |
|---|---|---|
| ApprovalsProvider.tsx | provider | Mounts the modal and owns open and close state |
| ApprovalCenterModal.tsx | view | Renders the approval queue and its decisions |
| approval-center-vm.ts | vm | Maps approval records to list and detail slots |
| approval-center-vm.test.ts | test | Unit tests for the approval center view model |
