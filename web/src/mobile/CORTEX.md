Please update me when files in this folder change.

The mobile chrome. `mobile-only-from-router` means only `router.tsx`, `RootRouter.tsx`
and `responsive-route.tsx` may import this tree from outside, and `features-not-to-mobile`
means no feature may import it — so the whole directory stays movable as a unit. It
imports `features/`, `design/`, `theme/`, `i18n/` and `lib/` freely, plus
`shell/ShellProviders` (the shared provider set, mounted by each chrome).

## Root

| filename | role | function |
|---|---|---|
| MobileShell.tsx | entry | The chrome: `MobileProviders` (ShellProviders + `MNotificationMount` + `MUpdateMount`), animated outlet, bottom tab bar, viewport height |
| mobile-routes.tsx | core | The route objects the root router splices in, each wrapped in `ResponsiveRoute mobile` |
| mobile-route-manifest.ts | core | Route id ↔ path manifest; `matchMobileRoute` / `mobileRoutePath`, used by `responsive-route.tsx` to translate across chromes |
| mobile-navigation.ts | core | Tab switching and the hardware/browser back stack |
| mobile-tabs.ts | core | Which tab a path belongs to (`activeTabId`, `isTabRoute`) |
| BottomTabBar.tsx | core | The bottom tab bar |
| MobileAnimatedOutlet.tsx | core | Push/pop transition around the routed screen |
| use-viewport-height.ts | utility | Real viewport height on mobile browsers (URL bar / keyboard insets) |
| `*.test.ts(x)` | test | vitest, colocated (mobile-navigation, mobile-route-manifest, mobile-routes, mobile-tabs, MobileAnimatedOutlet, use-viewport-height) |

## screens/ — all mobile screens, 119 files

Naming, and what the split means:

- **`M<Name>Screen.tsx`** — the container: controllers, queries, navigation, sheets. 25 today.
- **`M<Name>View.tsx`** — presentational, props only, render-testable without a provider.
  21 today; five screens (Budget, Mcp, Platform, Profiles, RuntimeSettings) render inline
  with no View, and `MNewProjectView` has no Screen — it is rendered inside a sheet.
- **`m-<name>-vm.ts`** — the pure view-model behind the pair: snapshot in, render-ready
  object out, no React and no tRPC. 14 today, and where the screen's unit tests live.

**The `COPY` convention.** 16 screens declare a local `const COPY: { en, zh }` table beside
the component and pick with `pickCopy(useLang())`. That copy **bypasses `@/i18n`** — the
strings are not in `vocab.ts`, so they are not searchable there, not typed against `Vocab`
and not covered by its key parity. Deliberate: screen-local copy nothing else shares. The
remaining screens call `useVocab()` normally; both patterns are live.

Entry points by group (the `Screen` is the routed one in each):

- **Chat** — `MChatScreen` / `MChatView` (+ `.types`) / `m-chat-vm`, with `MChatSheets`,
  `MChatAttachments` + `m-chat-attachments`, `MChatComposerPresentation`,
  `MChatInlineThreadCard`, `MChatMessageActions`, `MDecisionCards`, `MInteractionCards`,
  and the drill-in `MPlanReadScreen` / `MPlanReadView`.
- **Sessions & projects** — `MSessionListScreen` / `MSessionListView` / `m-session-list-vm`,
  `MProjectScreen` / `MProjectView` / `m-project-vm`, `MNewProjectView` + `m-new-project-flow`.
- **Tasks & threads** — `MTasksScreen` / `MTasksView`, `MTaskDetailScreen` / `MTaskDetailView`
  / `m-task-detail-vm`, `MThreadsScreen` / `MThreadsView` / `m-threads-vm`,
  `MThreadDetailScreen` / `MThreadDetailView` / `m-thread-detail-vm`.
- **Memory & notes** — `MMemoryScreen` / `MMemoryView` / `m-memory-vm`, `MMemoryFileScreen` /
  `MMemoryFileView` / `m-memory-file-vm`, `MNotesScreen` / `MNotesView` / `m-notes-vm`,
  `MNotesProjectCard`, `m-notes-gestures`.
- **Ops** — `MApprovalsScreen` / `MApprovalsView` / `m-approvals-vm`, `MIssuesScreen` /
  `MIssuesView`, `MUsageScreen` / `MUsageView`, `MMachinesScreen` / `MMachinesView` /
  `m-machines-vm`, `MDaemonScreen` / `MDaemonView` / `m-daemon-vm`, `MHooksScreen` /
  `MHooksView` / `m-hooks-vm`.
- **Settings** — `MSettingsScreen` / `MSettingsView` / `m-settings-vm` + `MSettingsControls`,
  and the sub-screens `MAppearanceScreen` / `MAppearanceView`, `MAccountsScreen` /
  `MAccountsView`, `MProfilesScreen`, `MBudgetScreen`, `MPlatformScreen`, `MMcpScreen`,
  `MRuntimeSettingsScreen`, plus `MCustomProviderSheet` and `MNativeNotificationsCard`.
- **Schedule** — `MScheduleSheet` + `MScheduleSheetLevels`, `MScheduleEditor` +
  `MScheduleEditorFields`.
- **Notifications & update** — `MNotificationMount`, `MNotificationToaster`,
  `m-notification-routing`; `MUpdateMount`, `MUpdateFrame`, `MAppUpdateDialog`,
  `MHotUpdateDialog`. The two `*Mount`s are this chrome's headless adapters.
- **Misc** — `m-connection.ts` (connection state/copy for this chrome).
- **`*.test.ts(x)`** — vitest, colocated: every `m-*-vm` plus ~15 Screen/View render tests.

## shared/ and ui/

| filename | role | function |
|---|---|---|
| shared/mobile-session-vm.ts | core | Session view-model used by more than one screen (chat + session list) |
| shared/mobile-machines-vm.ts | core | Machines view-model used by the machines screen and the settings surface |
| shared/MobileThreadStepper.tsx | core | The thread step widget several screens embed |
| ui/kit.tsx | core | The mobile kit: `MScreen`, `MTabHeader`, `MDrillHeader`, `MScrollBody`, `MCard`, `MPill`, `MDot`, `MSegmented`, `MGroupLabel` — 1:1 from the mobile scheme |
| ui/composer.tsx | core | `MComposer` + `ComposerFullscreen` and their line/char count labels |
| ui/format.ts | utility | `relTimeZh`, `fmtMoney`, and `pickCopy` (the COPY-table picker above) |
