Please update me when files in this folder change

Shared Web authentication overlay for starting and completing metadata-only LoginFlow sessions.

| filename | role | function |
|---|---|---|
| LoginFlowModal.tsx | view | Drives prefilled auth steps, notices and cancellation |
| LoginFlowModal.test.tsx | test | Tests prefill, reuse, fencing and non-echo |
| LoginFlowProvider.tsx | provider | Reuses notice-bound flows in the global modal |
| login-flow-vm.ts | vm | Maps LoginFlow metadata to render states |
| login-flow-vm.test.ts | test | Tests prompts, notices and terminal states |
