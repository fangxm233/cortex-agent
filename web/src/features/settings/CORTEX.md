Please update me when files in this folder change

Desktop settings overlay: one modal with left nav and twelve sections, mounted globally by its provider.
Panels read snapshots; accounts, budget, runtime, profiles, hooks, templates, and plugins own mutations.

| filename | role | function |
|---|---|---|
| SettingsProvider.tsx | provider | Provides global open and close for the modal |
| SettingsModal.tsx | view | Bounds editor panels and hands off account login |
| SettingsPanels.tsx | view | Renders non-runtime platform and config sections |
| AccountsPanel.tsx | view | Filters providers and manages account login/logout |
| AccountsPanel.test.tsx | test | Tests account rows and native actions |
| CustomProvidersCard.tsx | view | Edits custom PI providers and API protocol |
| CustomProvidersCard.test.tsx | test | Tests provider selections, writes and delete guard |
| custom-provider-vm.ts | vm | Validates custom provider drafts and builds mutation args |
| custom-provider-vm.test.ts | test | Unit tests for the custom provider view model |
| AuthLoginEntry.test.tsx | test | Tests shell, login, and save placement |
| RuntimeSettingsPanels.tsx | view | Edits runtime switches and job cadence selections |
| RuntimeSettingsPanels.test.tsx | test | Tests runtime selections and production writes |
| AppearancePanel.tsx | view | Language and theme toggles kept device-local |
| BudgetPanel.tsx | view | Writes global and per-project daily/monthly spend limits |
| budget-vm.ts | vm | Resolves budget scope and builds chips, payload and spend bar |
| budget-vm.test.ts | test | Unit tests for the budget view model |
| ProfilesPanel.tsx | view | Profile table and typed profile selectors |
| ProfilesPanel.test.tsx | test | Tests profile fields, gating and delete guard |
| profiles-panel-vm.ts | vm | Validates profile drafts and builds mutation args |
| profiles-panel-vm.test.ts | test | Unit tests for the profiles panel view model |
| HooksPanel.tsx | view | Hook editor with result selection and test runner |
| HooksPanel.test.tsx | test | Tests hook result gating, layout and runner |
| hooks-panel-vm.ts | vm | Filters, groups, validates and builds hook mutation args |
| hooks-panel-vm.test.ts | test | Unit tests for the hooks panel view model |
| TemplatesPanel.tsx | view | Bounds template scrolling and fixes action bar |
| TemplatesPanel.test.tsx | test | Tests detail-pane tabs, guards and save gating |
| templates-panel-vm.ts | vm | Filters, parses editor JSON and builds template mutation args |
| templates-panel-vm.test.ts | test | Unit tests for the templates panel view model |
| PluginsPanel.tsx | view | Edits plugin targets and ack flow |
| PluginsPanel.test.tsx | test | Covers plugin view and stale states |
| PluginsPanel.keyboard.test.tsx | test | Covers plugin mode keyboard access |
| PluginsPanel.container.test.tsx | test | Covers mounted query and native controls |
| plugins-panel-vm.ts | vm | Syncs drafts and detects conflicts |
| plugins-panel-vm.test.ts | test | Covers plugin VM conflict rules |
| platform-env.ts | vm | Defines env indexes, settings, and durations |
| platform-env.test.ts | test | Tests env redaction, settings, and durations |
| settings-nav.ts | vm | Lists settings sections and descriptions |
| settings-ui.tsx | view | Shared native controls and cards |
| settings-ui.test.tsx | test | Covers shared control semantics |
