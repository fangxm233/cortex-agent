Please update me when files in this folder change

Desktop settings overlay: one modal with a left nav and ten sections, mounted globally by its provider.
Panels read a single config snapshot; only the budget panel writes back, the rest are read-only.

| filename | role | function |
|---|---|---|
| SettingsProvider.tsx | provider | Provides global open and close for the modal |
| SettingsModal.tsx | view | Dialog with left nav and panel switching |
| SettingsPanels.tsx | view | Renders read-only config and mounted hooks |
| SettingsPanels.test.tsx | test | Tests mounted hook state rendering |
| AppearancePanel.tsx | view | Language and theme toggles kept device-local |
| BudgetPanel.tsx | view | Budget panel that writes the daily spend limit |
| budget-vm.ts | vm | Derives budget chips, payload and spend bar |
| budget-vm.test.ts | test | Unit tests for the budget view model |
| platform-env.ts | vm | Maps redacted env keys to safe settings rows |
| platform-env.test.ts | test | Unit tests for env row redaction |
| settings-nav.ts | vm | Lists settings sections and config sources |
| settings-ui.tsx | view | Shared card, row, toggle and radio primitives |
