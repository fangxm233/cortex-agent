Please update me when files in this folder change

Shared Web authentication overlay for notice-bound or settings-targeted metadata-only LoginFlow sessions.

| filename | role | function |
|---|---|---|
| LoginFlowModal.tsx | view | Drives auth target selection and login steps |
| LoginFlowModal.test.tsx | test | Tests selection, reuse, fencing and non-echo |
| LoginFlowProvider.tsx | provider | Opens settings targets and reuses notice flows |
| login-flow-vm.ts | vm | Maps LoginFlow metadata to render states |
| login-flow-vm.test.ts | test | Tests prompts, notices and terminal states |
| ProviderIcon.tsx | view | Brand icon with letter fallback for account rows |
| ProviderIcon.test.tsx | test | Tests icon mapping and letter fallback |
| provider-icon-data.ts | data | Vendored monochrome brand svg markup (MIT) |
