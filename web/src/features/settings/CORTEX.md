Please update me when files in this folder change

Desktop settings overlay: one modal with left nav and thirteen sections, mounted globally by its provider.
Panels keep their presentation while canonical controllers and VMs in this folder can serve mobile too.

| filename | role | function |
|---|---|---|
| SettingsProvider.tsx | provider | Provides global open and close for the modal |
| SettingsModal.tsx | view | Routes panels and lets Usage own its title/action header |
| SettingsPanels.tsx | view | Renders non-runtime platform and config sections |
| AccountsPanel.tsx | view | Presents desktop account cards over the shared account owner and VM |
| AccountsPanel.test.tsx | test | Tests desktop account permissions, actions, redaction and rescans |
| accounts-vm.ts | vm | Canonically derives secret-free desktop/mobile account cards, groups and summaries |
| accounts-vm.test.ts | test | Tests shared account grouping, status, filtering, actions and summaries |
| useAccountsController.ts | controller | Owns auth status, logout, rescan, exact refreshes and operation feedback |
| useAccountsController.test.tsx | test | Tests shared account query/mutation lifecycle, pending gates, refreshes and toasts |
| CustomProvidersCard.tsx | view | Presents the desktop custom PI provider list and editor over shared ownership |
| CustomProvidersCard.test.tsx | test | Tests desktop provider selections, writes and delete guard |
| custom-provider-vm.ts | vm | Validates custom provider drafts, resolves field copy and builds mutation args |
| custom-provider-vm.test.ts | test | Tests custom provider drafts, validation copy and mutation payloads |
| useCustomProvidersController.ts | controller | Owns custom-provider list, drafts, validation, writes, delete guard and feedback |
| useCustomProvidersController.test.tsx | test | Tests shared custom-provider drafts, independent writes, refreshes and toasts |
| AuthLoginEntry.test.tsx | test | Tests non-stacked settings-to-login handoff |
| RuntimeSettingsPanels.tsx | view | Presents desktop runtime switches, retention days, and job cadence selections over the shared writer |
| RuntimeSettingsPanels.test.tsx | test | Tests desktop runtime rows, snapshot state, validation and toggle interaction |
| runtime-settings-writer.ts | hook | Owns typed config.set commits, refresh serialization and the desktop/mobile runtime writer |
| runtime-settings-writer.test.tsx | test | Tests runtime commit lifecycle, failures, refresh gating and production mutation wiring |
| AppearancePanel.tsx | view | Edits language, theme, palette, accent and motion |
| AppearancePanel.test.tsx | test | Tests theme, palette, accent and motion wiring |
| BudgetPanel.tsx | view | Keeps desktop budget scope/form/query presentation over the shared writer |
| budget-vm.ts | vm | Shares budget scope, draft, payload, chip, formatting and spend-bar derivations |
| budget-vm.test.ts | test | Tests budget scope, drafts, parsing, payloads and percentage arithmetic |
| useBudgetWriter.ts | hook | Shares budget config.set and config/cost invalidation while preserving write/clear operations |
| useBudgetWriter.test.tsx | test | Tests writer payloads, operation results, invalidation and failures |
| ProfilesPanel.tsx | view | Profile table and editor using shared backend transitions and error copy |
| ProfilesPanel.test.tsx | test | Tests profile permissions, secret safety, errors and delete guard |
| profiles-panel-vm.ts | vm | Shares profile transitions, validation copy and mutation args across desktop/mobile |
| profiles-panel-vm.test.ts | test | Tests profile transitions, error copy, validation and mutation args |
| HooksPanel.tsx | view | Hook editor with result selection and test runner |
| HooksPanel.test.tsx | test | Tests hook permissions, validation, delete state and runner errors |
| hooks-panel-vm.ts | vm | Canonically detects/groups hook namespaces for desktop/mobile, then validates editor mutations |
| hooks-panel-vm.test.ts | test | Tests known/other grouping, filtering, validation, capabilities and mutation payloads |
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
| platform-env.ts | vm | Defines env indexes, writable descriptors, safe whole numbers and durations |
| platform-env.test.ts | test | Tests env redaction, setting lookup, whole-number parsing, duration bounds and retention limits |
| settings-nav.ts | vm | Lists settings sections and descriptions |
| settings-ui.tsx | view | Shared cards and style-overridable native controls |
| settings-ui.test.tsx | test | Covers control semantics and style overrides |
