Please update me when files in this folder change

Desktop settings overlay: one modal with left nav and thirteen sections, mounted globally by its provider.
Panels read snapshots; Usage independently queries the shared web usage feature.

| filename | role | function |
|---|---|---|
| SettingsProvider.tsx | provider | Provides global open and close for the modal |
| SettingsModal.tsx | view | Routes panels and lets Usage own its title/action header |
| SettingsPanels.tsx | view | Renders non-runtime platform and config sections |
| AccountsPanel.tsx | view | Filters providers and manages account login/logout |
| AccountsPanel.test.tsx | test | Tests account permissions, actions, redaction and rescans |
| CustomProvidersCard.tsx | view | Edits custom PI providers and API protocol |
| CustomProvidersCard.test.tsx | test | Tests provider selections, writes and delete guard |
| custom-provider-vm.ts | vm | Validates custom provider drafts and builds mutation args |
| custom-provider-vm.test.ts | test | Unit tests for the custom provider view model |
| AuthLoginEntry.test.tsx | test | Tests non-stacked settings-to-login handoff |
| RuntimeSettingsPanels.tsx | view | Edits runtime switches, retention days, and job cadence selections |
| RuntimeSettingsPanels.test.tsx | test | Tests runtime state, validation, failures and production writes |
| AppearancePanel.tsx | view | Language and theme toggles kept device-local |
| BudgetPanel.tsx | view | Writes global and per-project daily/monthly spend limits |
| budget-vm.ts | vm | Resolves budget scope and builds chips, payload and spend bar |
| budget-vm.test.ts | test | Tests budget scope, parsing, payloads and percentage arithmetic |
| ProfilesPanel.tsx | view | Profile table and typed profile selectors |
| ProfilesPanel.test.tsx | test | Tests profile permissions, secret safety, errors and delete guard |
| profiles-panel-vm.ts | vm | Validates profile drafts and builds mutation args |
| profiles-panel-vm.test.ts | test | Unit tests for the profiles panel view model |
| HooksPanel.tsx | view | Hook editor with result selection and test runner |
| HooksPanel.test.tsx | test | Tests hook permissions, validation, delete state and runner errors |
| hooks-panel-vm.ts | vm | Filters, groups, validates and builds hook mutation args |
| hooks-panel-vm.test.ts | test | Tests hook filtering, validation, capabilities and mutation payloads |
| TemplatesPanel.tsx | view | Bounds template scrolling and fixes action bar |
| TemplatesPanel.test.tsx | test | Tests parse errors, mutation guards, validation and path safety |
| templates-panel-vm.ts | vm | Filters, parses editor JSON and builds template mutation args |
| templates-panel-vm.test.ts | test | Unit tests for the templates panel view model |
| PluginsPanel.tsx | view | Bounds plugin cards and edits assignments |
| PluginsPanel.test.tsx | test | Covers plugin view and stale states |
| PluginsPanel.keyboard.test.tsx | test | Covers plugin mode keyboard access |
| PluginsPanel.container.test.tsx | test | Covers query failures, dirty guards, refresh and conflict handling |
| plugins-panel-vm.ts | vm | Syncs drafts and detects conflicts |
| plugins-panel-vm.test.ts | test | Covers plugin VM conflict rules |
| platform-env.ts | vm | Defines env indexes, writable settings, and durations |
| platform-env.test.ts | test | Tests env redaction, setting lookup, duration bounds and retention limits |
| settings-nav.ts | vm | Lists settings sections and descriptions |
| settings-ui.tsx | view | Shared cards and style-overridable native controls |
| settings-ui.test.tsx | test | Covers control semantics and style overrides |
