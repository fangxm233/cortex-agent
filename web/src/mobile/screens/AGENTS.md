Please update me when files in this folder change.

All mobile screens (124 files), routed by `../mobile-routes.tsx`.

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
  `MChatInlineThreadCard`, `MChatMessageActions`, `MInteractionCards`, `useComposerClearance`
  (floating-composer transcript clearance) and the drill-in `MPlanReadScreen` / `MPlanReadView`.
  Tool calls, subagents and decisions render through the SHARED `features/session` blocks
  (`ToolCallsRow`, `SubagentBlock`, `DecisionCardGroup`) — there is no mobile twin of them.
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
- **Settings** — `MSettingsScreen` / `MSettingsView` / `m-settings-vm` + `MSettingsControls`
  (row language shared with desktop `settings/ui/settings-style.css`) + `mobile-settings.css`,
  and the sub-screens `MAppearanceScreen` / `MAppearanceView`, `MAccountsScreen` /
  `MAccountsView`, `MProfilesScreen`, `MBudgetScreen`, `MPlatformScreen`, `MMcpScreen`,
  `MRuntimeSettingsScreen`, plus `MCustomProviderSheet` and `MNativeNotificationsCard`.
- **Schedule** — `MScheduleSheet` + `MScheduleSheetLevels`, `MScheduleEditor` +
  `MScheduleEditorFields`.
- **Notifications & update** — `MNotificationMount`, `MNotificationToaster`,
  `m-notification-routing`; `MUpdateMount`, `MUpdateFrame`, `MAppUpdateDialog`,
  `MHotUpdateDialog`. The two `*Mount`s are this chrome's headless adapters.
- **Misc** — `m-connection.ts` (connection state/copy for this chrome).
- **`*.test.ts(x)`** — vitest, colocated: every `m-*-vm`, ~20 Screen/View render tests, and the
  cross-screen `mobile-presentation` / `mobile-chat-presentation` contrast and layout contracts.

