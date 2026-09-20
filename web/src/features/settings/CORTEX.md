Please update me when files in this folder change.

The settings modal and everything in it (69 files). Step 2 made the layering the filenames
already implied structural: `panels/` renders, `controllers/` talks to tRPC, `vm/` computes,
`ui/` supplies the shared cards and controls.

| filename | role | function |
|---|---|---|
| SettingsModal.tsx | entry | The modal shell: nav column + the selected section's panel |
| useSettings.tsx | entry | The registry key and `useSettings()` / `SettingsModalHost`, mounted by `shell/ShellModals` |
| settings-nav.ts | core | `SettingsSectionKey` and the nav model; labels resolved via `getSettingsNav(L)` |
| AuthLoginEntry.test.tsx | test | vitest, colocated |

## The layering

| dir | what goes there |
|---|---|
| `panels/` | One panel per settings section — the rendering, and the container that wires it (27 files) |
| `controllers/` | `use*Controller` / writer hooks: the only place this feature's tRPC queries, mutations, query keys and invalidations live |
| `vm/` | Pure view-models: snapshot in, render-ready object out. No React, no tRPC. Where the unit tests are |
| `ui/` | The shared settings kit: `settings-ui.tsx` (`SButton`, `SCard`, `SFieldRow`, …), `plugin-ui.tsx`, `platform-settings.css` |

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
- **Profiles / budget / machines / templates** — `ProfilesPanel`, `BudgetPanel`,
  `MachinesPanel`, `TemplatesPanel`.
- **Plugins** — `PluginsPanel`, `PluginAssignPanel`, `PluginSkillsTab`, `PluginMcpTab`.
- **Hooks & runtime** — `HooksPanel`, `RuntimeSettingsPanels`.
- **Update** — `AppUpdateCard`.
- **`*.test.tsx`** — colocated: Accounts, AppUpdateCard, Budget, CustomProviders, Platform,
  RuntimeSettingsPanels, and the two `.container.test.tsx` (Plugins, PluginAssign).

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
