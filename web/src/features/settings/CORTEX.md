Please update me when files in this folder change

Desktop settings overlay: one modal with left nav and ten sections, mounted globally by its provider.
Panels read config snapshots; budget and runtime toggles write config, while hooks owns its registry mutations.

| filename | role | function |
|---|---|---|
| SettingsProvider.tsx | provider | Provides global open and close for the modal |
| SettingsModal.tsx | view | Dialog with nav and full-height panel content |
| SettingsPanels.tsx | view | Renders non-runtime config sections and backend login entry |
| AuthLoginEntry.test.tsx | test | Tests the desktop backend login entry |
| RuntimeSettingsPanels.tsx | view | Reads and writes runtime settings toggles |
| RuntimeSettingsPanels.test.tsx | test | Tests toggle rows and production write adapter |
| AppearancePanel.tsx | view | Language and theme toggles kept device-local |
| BudgetPanel.tsx | view | Budget panel that writes the daily spend limit |
| budget-vm.ts | vm | Derives budget chips, payload and spend bar |
| budget-vm.test.ts | test | Unit tests for the budget view model |
| HooksPanel.tsx | view | Full-height hook editor and test runner |
| HooksPanel.test.tsx | test | Tests hook layout, gating and the test runner |
| hooks-panel-vm.ts | vm | Filters, groups, validates and builds hook mutation args |
| hooks-panel-vm.test.ts | test | Unit tests for the hooks panel view model |
| platform-env.ts | vm | Defines env indexes and writable runtime flags |
| platform-env.test.ts | test | Tests env redaction and settings indexing |
| settings-nav.ts | vm | Lists settings sections and config sources |
| settings-ui.tsx | view | Shared card, row, field, button, toggle and radio primitives |
