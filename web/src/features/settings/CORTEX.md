Please update me when files in this folder change

Desktop settings overlay: one modal with left nav and ten sections, mounted globally by its provider.
Most panels read one config snapshot; budget writes the daily limit, while hooks uses hooks.list and hooks.*
mutations in a full-height master-detail surface.

| filename | role | function |
|---|---|---|
| SettingsProvider.tsx | provider | Provides global open and close for the modal |
| SettingsModal.tsx | view | Dialog with nav and full-height panel content |
| SettingsPanels.tsx | view | Renders the read-only config sections |
| AppearancePanel.tsx | view | Language and theme toggles kept device-local |
| BudgetPanel.tsx | view | Budget panel that writes the daily spend limit |
| budget-vm.ts | vm | Derives budget chips, payload and spend bar |
| budget-vm.test.ts | test | Unit tests for the budget view model |
| HooksPanel.tsx | view | Full-height hook editor and test runner |
| HooksPanel.test.tsx | test | Tests hook layout, gating and the test runner |
| hooks-panel-vm.ts | vm | Filters, groups, validates and builds hook mutation args |
| hooks-panel-vm.test.ts | test | Unit tests for the hooks panel view model |
| platform-env.ts | vm | Maps redacted env keys to safe settings rows |
| platform-env.test.ts | test | Unit tests for env row redaction |
| settings-nav.ts | vm | Lists settings sections and config sources |
| settings-ui.tsx | view | Shared card, row, field, button, toggle and radio primitives |
