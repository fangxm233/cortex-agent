Please update me when files in this folder change

Desktop settings overlay: one modal with a left nav and ten sections, mounted globally by its provider.
Most panels read a single config snapshot and are read-only; the budget panel writes the daily limit
back through config.set, and the hooks panel owns its own hooks.list query plus the full hooks.*
create/update/enable/remove/test surface.

| filename | role | function |
|---|---|---|
| SettingsProvider.tsx | provider | Provides global open and close for the modal |
| SettingsModal.tsx | view | Dialog with left nav and panel switching |
| SettingsPanels.tsx | view | Renders the read-only config sections |
| AppearancePanel.tsx | view | Language and theme toggles kept device-local |
| BudgetPanel.tsx | view | Budget panel that writes the daily spend limit |
| budget-vm.ts | vm | Derives budget chips, payload and spend bar |
| budget-vm.test.ts | test | Unit tests for the budget view model |
| HooksPanel.tsx | view | Hook registry master-detail editor and test runner |
| HooksPanel.test.tsx | test | Tests hook rows, capability gating and the test runner |
| hooks-panel-vm.ts | vm | Filters, groups, validates and builds hook mutation args |
| hooks-panel-vm.test.ts | test | Unit tests for the hooks panel view model |
| platform-env.ts | vm | Maps redacted env keys to safe settings rows |
| platform-env.test.ts | test | Unit tests for env row redaction |
| settings-nav.ts | vm | Lists settings sections and config sources |
| settings-ui.tsx | view | Shared card, row, field, button, toggle and radio primitives |
