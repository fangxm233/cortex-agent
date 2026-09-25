Please update me when files in this folder change.

The settings modal and everything in it (79 files), filed by layer: `panels/` renders, `controllers/` talks to tRPC, `vm/` computes,
`ui/` supplies the shared cards and controls.

| filename | role | function |
|---|---|---|
| SettingsModal.tsx | entry | The glass modal shell: grouped nav column, caller-chosen first section, header action slot, the selected section's panel, dirty-navigation guards |
| useSettings.tsx | entry | The registry key and `useSettings()` (`open`, `openSection(key)`, `close`) / `SettingsModalHost`, mounted by `shell/ShellModals`; loads the portal styles |
| settings-nav.ts | core | `SettingsSectionKey`, the grouped nav model (`getSettingsNavGroups(L)`) and per-section glyphs (`getSettingsNavIcon`) |
| AuthLoginEntry.test.tsx, useSettings.test.tsx | test | vitest, colocated |

## The layering

| dir | what goes there |
|---|---|
| `panels/` | One panel per settings section — the rendering, and the container that wires it (31 files) |
| `controllers/` | `use*Controller` / writer hooks: the only place this feature's tRPC queries, mutations, query keys and invalidations live |
| `vm/` | Pure view-models: snapshot in, render-ready object out. No React, no tRPC. Where the unit tests are |
| `ui/` | The shared settings kit and its styles (see below) — the row language the mobile settings screens reuse |

## Container / View convention

`PluginsPanel.tsx` is the canonical example, and reads top to bottom as the three layers:

- **`PluginsPanel()`** — the container. Runs `useQuery`, calls `usePluginAuthoring()` from
  `controllers/`, holds selection state, renders the View. Not render-testable alone.
- **`PluginsPanelView(props)`** — exported beside it, presentational, props only. This is
  what a render test mounts, and why `PluginsPanel.container.test.tsx` can drive the whole
  panel against a faked adapter with no server.
- **`vm/plugins-panel-vm.ts`** — pure: `PLUGIN_TABS`, `filterPlugins`, `pluginUsage`,
  `resolvePluginSelection`. Display logic goes here first; it is the cheapest thing to test.

`XPanel.tsx` (+ `XPanelView`) / `controllers/useXController.ts` / `vm/x-vm.ts` is the shape
every other panel follows. `mobile/screens` does the same split as `M*Screen` / `M*View`.

## panels/ by section

- **Appearance** — `AppearancePanel` (renders `theme/PaletteControls` + `AccentPicker`).
- **Platform** — `PlatformPanel`, `PlatformConnectionFields`, `PlatformRuntimeFields`,
  `SettingsPanels` (shared badges + the read-only MCP panel).
- **Accounts & providers** — `AccountsPanel`, `CustomProvidersCard`, `UiSignOutCard`.
- **Profiles / budget / machines** — `ProfilesPanel`, `BudgetPanel`, `MachinesPanel`.
- **Templates** — `TemplatesPanel` (list + `TemplatesPanelView`) and `TemplateDetailPane` (sealed
  source editor, validation, references, plugin assignments).
- **Plugins** — `PluginsPanel`, `PluginAssignPanel`, `PluginSkillsTab`, `PluginMcpTab`.
- **Hooks** — `HooksPanel` (list + `HooksPanelView`), `HookDetailPane` (detail, test runner),
  `HookEditorForm` (trigger, action, scope).
- **Runtime** — `RuntimeSettingsPanels`.
- **Update** — `AppUpdateCard`.
- **`*.test.tsx`** — colocated: Accounts, AppUpdateCard, Budget, CustomProviders, Platform,
  Profiles, RuntimeSettingsPanels, and the two `.container.test.tsx` (Plugins, PluginAssign).

## ui/

- `settings-kit.tsx` — the row language: `SRowGroup`, `SRow`, `SSection`, `SSegmented`, raised
  controls, badges and the header-action slot. `settings-ui.tsx` (`SButton`, `SCard`,
  `SFieldRow`, …) re-exports it.
- `master-detail-ui.tsx` — the list/detail pane shells Hooks and Templates share; `plugin-ui.tsx`
  plugin tiles; `platform-ui.ts` platform field/hint/block styles.
- CSS: `settings-style.css` (glass materials, small-text ink — also imported by mobile),
  `settings-portals.css` (dropdowns and nested dialogs portalled out of the modal),
  `desktop-panels.css` (adaptive panel layout, also used by `usage/UsagePanel`),
  `platform-settings.css`.

## controllers/ and vm/

- **controllers/** — `useAccountsController`, `useCustomProvidersController`,
  `useProfilesController`, `useTemplatesController`, `useHooksController`,
  `usePluginAuthoring`, `usePlatformSettings`, `useBudgetWriter`, `runtime-settings-writer`.
- **vm/** — `accounts-vm`, `budget-vm`, `custom-provider-vm`, `hooks-panel-vm`,
  `platform-env`, `platform-settings-vm`, `plugin-assign-vm`, `plugin-authoring-vm`,
  `plugins-panel-vm`, `profiles-panel-vm`, `templates-panel-vm` — each with a colocated test
  except `platform-settings-vm` and `plugins-panel-vm` (covered through their panels).

`settings↔usage` is the one allow-listed feature cycle; six of the frozen
`components-not-direct-trpc` baseline entries are panels under this directory.
