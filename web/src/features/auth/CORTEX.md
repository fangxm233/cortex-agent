Please update me when files in this folder change

Shared Web authentication overlay for notice-bound or settings-targeted metadata-only LoginFlow sessions.

| filename | role | function |
|---|---|---|
| LoginFlowModal.tsx | view | Drives notice or settings-targeted auth steps |
| LoginFlowModal.test.tsx | test | Tests target prefill, reuse, fencing and non-echo |
| LoginFlowProvider.tsx | provider | Opens settings targets and reuses notice flows |
| login-flow-vm.ts | vm | Maps LoginFlow metadata to render states |
| login-flow-vm.test.ts | test | Tests prompts, notices and terminal states |
