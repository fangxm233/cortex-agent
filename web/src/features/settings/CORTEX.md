Please update me when files in this folder change

Desktop settings overlay: one modal with left nav and eleven sections, mounted globally by its provider.
Panels read config/auth snapshots; accounts, budget, runtime, profiles, hooks and thread templates
own their mutations.

| filename | role | function |
|---|---|---|
| SettingsProvider.tsx | provider | Provides global open and close for the modal |
| SettingsModal.tsx | view | Dialog with nav and non-stacked account login handoff |
| SettingsPanels.tsx | view | Renders non-runtime platform and config sections |
| AccountsPanel.tsx | view | Filters providers and manages account login/logout |
| AccountsPanel.test.tsx | test | Tests desktop account state and action visibility |
| CustomProvidersCard.tsx | view | Lists, edits and deletes user-defined PI providers |
| CustomProvidersCard.test.tsx | test | Tests custom provider rows, save payload and delete guard |
| custom-provider-vm.ts | vm | Validates custom provider drafts and builds mutation args |
| custom-provider-vm.test.ts | test | Unit tests for the custom provider view model |
| AuthLoginEntry.test.tsx | test | Tests settings shell copy and account login handoff |
| RuntimeSettingsPanels.tsx | view | Edits runtime switches and built-in job intervals |
| RuntimeSettingsPanels.test.tsx | test | Tests runtime rows and production write adapter |
| AppearancePanel.tsx | view | Language and theme toggles kept device-local |
| BudgetPanel.tsx | view | Writes global and per-project daily/monthly spend limits |
| budget-vm.ts | vm | Resolves budget scope and builds chips, payload and spend bar |
| budget-vm.test.ts | test | Unit tests for the budget view model |
| ProfilesPanel.tsx | view | Profile table with create, edit and delete |
| ProfilesPanel.test.tsx | test | Tests profile rows, editor gating and delete guard |
| profiles-panel-vm.ts | vm | Validates profile drafts and builds mutation args |
| profiles-panel-vm.test.ts | test | Unit tests for the profiles panel view model |
| HooksPanel.tsx | view | Full-height hook editor and test runner |
| HooksPanel.test.tsx | test | Tests hook layout, gating and the test runner |
| hooks-panel-vm.ts | vm | Filters, groups, validates and builds hook mutation args |
| hooks-panel-vm.test.ts | test | Unit tests for the hooks panel view model |
| TemplatesPanel.tsx | view | Thread-template editor with validation, references and write guards |
| TemplatesPanel.test.tsx | test | Tests detail-pane tabs, guards and save gating |
| templates-panel-vm.ts | vm | Filters, parses editor JSON and builds template mutation args |
| templates-panel-vm.test.ts | test | Unit tests for the templates panel view model |
| platform-env.ts | vm | Defines env indexes, settings, and durations |
| platform-env.test.ts | test | Tests env redaction, settings, and durations |
| settings-nav.ts | vm | Lists settings sections and descriptions |
| settings-ui.tsx | view | Shared card, row, field, button, toggle and radio primitives |
