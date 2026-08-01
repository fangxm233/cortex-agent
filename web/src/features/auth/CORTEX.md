Please update me when files in this folder change

Shared Web authentication overlay for starting and completing metadata-only LoginFlow sessions.

| filename | role | function |
|---|---|---|
| LoginFlowModal.tsx | view | Drives accessible login steps and safe cancellation |
| LoginFlowModal.test.tsx | test | Tests prompts, cancel fencing and secret non-echo |
| LoginFlowProvider.tsx | provider | Exposes the global login modal opener |
| login-flow-vm.ts | vm | Maps LoginFlow metadata to render states |
| login-flow-vm.test.ts | test | Tests prompts, notices and terminal states |
