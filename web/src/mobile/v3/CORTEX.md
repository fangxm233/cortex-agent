Please update me when files in this folder change

Mobile screens use a data/routing Screen and pure View, plus a local or canonical feature model.
Shared semantics stay in features/design while mobile retains distinct visual components and interactions.

| filename | role | function |
|---|---|---|
| MChatScreen.tsx | screen | Composes compact chat, shared run status, interactions, sends and attachments |
| m-chat-attachments.ts | hook | Owns mobile upload transport, draft effects and restored previews |
| MChatInlineThreadCard.tsx | view | Binds the selected session's live inline thread stepper |
| MChatScreen.optimistic.test.tsx | test | Tests status priority, Todo wiring, optimistic sends and shortcuts |
| MChatView.tsx | view | Facades chat contracts and renders lazy subagents, decisions, turn-copy and screen frame |
| MChatView.types.ts | types | Shares public chat, action, composer and sheet contracts |
| MChatMessageActions.tsx | view | Renders copy, long-press and edit action presentation |
| MChatAttachments.tsx | view | Renders transcript and composer attachment presentation |
| MChatSheets.tsx | view | Renders session, profile, browser and context sheets |
| MChatComposerPresentation.tsx | view | Renders composer modes, tools, slash and plus menus |
| MChatView.test.tsx | test | Tests lazy detail, prompts, counts, Todo, ＋ menu and copy |
| m-chat-vm.ts | vm | Maps shared run facts and builds chat rows, profile labels and menu placement |
| m-chat-vm.test.ts | test | Tests localized run status, profile labels and row state |
| MInteractionCards.tsx | view | Ask-user bottom-input and plan-approval cards |
| MDecisionCards.tsx | view | Decision cards with bottom-sheet detail and responses |
| MSessionListScreen.tsx | screen | Binds sessions and the sentinel-safe editor-capable Scheduled sheet |
| MSessionListView.tsx | view | Day-grouped session rows with clock entry |
| MScheduleSheet.tsx | view | One compact list/runs/editor bottom-sheet state machine with level-aware back |
| MScheduleSheetLevels.tsx | view | Presents the Scheduled list and run levels as small DOM-stable components |
| MScheduleSheet.test.tsx | test | Tests real-DTO edits, one-sheet levels, Escape and hardware-back retreat |
| MScheduleEditor.tsx | view | Composes shared-controller fields and honest once-edit limitations in-sheet |
| MScheduleEditorFields.tsx | view | Presents mobile schedule field groups as small DOM-stable components |
| m-session-list-vm.ts | vm | Groups sessions by day and derives status lines |
| m-session-list-vm.test.ts | test | Unit tests for the session list view model |
| MThreadsScreen.tsx | screen | Loads active and historical thread sections |
| MThreadsView.tsx | view | Grouped thread sections and wrapped pipelines |
| m-threads-vm.ts | vm | Derives budget, steps and task-linked card meta |
| m-threads-vm.test.ts | test | Tests mobile task-linked thread metadata |
| MThreadDetailScreen.tsx | screen | Binds routed mobile detail and cancellation |
| MThreadDetailView.tsx | view | Thread pipeline steps, artifacts and actions |
| MThreadDetailView.test.tsx | test | Unit tests for the cancel affordance |
| m-thread-detail-vm.ts | vm | Maps thread detail to steps, crumbs, artifacts |
| m-thread-detail-vm.test.ts | test | Unit tests for the thread detail view model |
| MTasksScreen.tsx | screen | Loads the project queue through canonical task grouping/order |
| MTasksView.tsx | view | Renders canonical task groups with mobile-specific blocker cards |
| MTaskDetailScreen.tsx | screen | Loads one task plus its verification evidence |
| MTaskDetailView.tsx | view | Task detail with blocker, fields, deps and history |
| m-task-detail-vm.ts | vm | Maps task blocker, claim and verification state |
| m-task-detail-vm.test.ts | test | Tests blocker, approval, claim and detail state |
| MProjectScreen.tsx | screen | Binds project data and shared creation with scope-first routing |
| MProjectView.tsx | view | Project-scoped tab with settings gear and switcher |
| m-project-vm.ts | vm | Derives thread counts, approval buckets, switch rows |
| m-project-vm.test.ts | test | Unit tests for the project view model |
| MNewProjectView.tsx | view | New-project sheet with shared validation and real errors |
| MNewProjectView.test.tsx | test | Tests mobile creation errors and pending gating |
| m-new-project-flow.ts | controller | Scopes a returned project id before close and navigation |
| m-new-project-flow.test.ts | test | Tests scope-before-navigation ordering |
| MApprovalsScreen.tsx | screen | Adapts the shared queue and owns expanded selection plus feedback reset |
| MApprovalsScreen.test.tsx | test | Tests selection fallback, card-switch reset and settled feedback clearing |
| MApprovalsView.tsx | view | Project-grouped queue with expandable decision card and optional feedback |
| MApprovalsView.test.tsx | test | Tests feedback presentation and reject handoff |
| m-approvals-vm.ts | vm | Groups pending approvals by project into card slots |
| m-approvals-vm.test.ts | test | Unit tests for the approvals view model |
| MIssuesScreen.tsx | screen | Binds canonical issue details/selection plus delete and handle flow |
| MIssuesView.tsx | view | Renders shared issue details with mobile inline delete and handle |
| MNotesScreen.tsx | screen | Binds private note queries and mutations |
| MNotesView.tsx | view | Lists tappable notes with swipe delete and input |
| MNotesProjectCard.tsx | view | Adds and previews notes on Projects |
| m-notes-vm.ts | vm | Groups notes and limits card previews |
| m-notes-vm.test.ts | test | Tests note counts, groups and local time |
| m-notes-gestures.ts | util | Resolves swipe and post-drag click suppression |
| m-notes-gestures.test.ts | test | Tests tap and swipe gesture thresholds |
| MMemoryScreen.tsx | screen | Builds shared tree facts and binds accordion state |
| MMemoryView.tsx | view | Keeps drill header above clean-read file accordions |
| m-memory-vm.ts | vm | Projects shared memory facts into timed rows and cards |
| m-memory-vm.test.ts | test | Tests shared-fact accordion, time and count projection |
| MMemoryFileScreen.tsx | screen | Binds one memory file by canonical path parameter |
| MMemoryFileView.tsx | view | Clean read-only markdown file with header metaline |
| m-memory-file-vm.ts | vm | Derives basename, byte size and metaline |
| MMachinesScreen.tsx | screen | Binds machine probes and registration approval requests |
| MMachinesView.tsx | view | Expandable machine cards with telemetry and Add action |
| MMachinesView.test.tsx | test | Tests collapsed and expanded panel gating |
| m-machines-vm.ts | vm | Maps machine records to cards and online counts |
| m-machines-vm.test.ts | test | Unit tests for the machines view model |
| MDaemonScreen.tsx | screen | Binds daemon status, counts and restart |
| MDaemonView.tsx | view | Shows daemon processes, restart and disconnect controls |
| m-daemon-vm.ts | vm | Builds daemon process, summary and event models |
| m-daemon-vm.test.ts | test | Unit tests for the daemon view model |
| MSettingsScreen.tsx | screen | Renders settings immediately and hydrates config summaries |
| MSettingsView.tsx | view | Keeps Daemon and Profile cards above title-only rows |
| MSettingsView.test.tsx | test | Tests canonical order, routing and live connection copy |
| MSettingsControls.tsx | view | Supplies compact rows, toggles and field-local validation feedback |
| MPlatformScreen.tsx | screen | Shows redacted platform state and queues reconnect approval |
| MProfilesScreen.tsx | screen | Selects defaults and edits profiles with shared transitions and field errors |
| MProfilesScreen.test.tsx | test | Tests mobile profile field errors and backend transitions |
| MBudgetScreen.tsx | screen | Keeps mobile budget scope/form/query view over the shared writer and operation toasts |
| MBudgetScreen.test.ts | test | Tests complete-pair initialization plus clear, write and failure feedback |
| MMcpScreen.tsx | screen | Lists configured MCP servers read-only |
| MRuntimeSettingsScreen.tsx | screen | Edits Notifications and Advanced runtime settings |
| MAppearanceScreen.tsx | screen | Binds device-local appearance state and back route |
| MAppearanceView.tsx | view | Language, theme, palette, accent and motion controls |
| MAppearanceView.test.tsx | test | Tests mobile appearance control wiring |
| MUsageScreen.tsx | screen | Binds localized Usage thresholds, saves, refresh, and settings back route |
| MUsageView.tsx | view | Keeps drill header above usage controls |
| MUsageView.test.tsx | test | Tests status omission, row saves, config gating, and refresh |
| m-settings-vm.ts | vm | Maps canonical config, cost and registry summaries |
| m-settings-vm.test.ts | test | Tests runtime source and summary data mapping |
| MAccountsScreen.tsx | screen | Loads account state and binds login, logout and rescan |
| MAccountsView.tsx | view | Shows account actions and the model rescan control |
| MAccountsView.test.tsx | test | Tests account permissions, pending actions and credential redaction |
| MAccountsView.custom.test.tsx | test | Tests custom-provider edit actions and delete confirmation |
| MCustomProviderSheet.tsx | view | Bottom-sheet editor for one custom PI provider |
| m-accounts-vm.ts | vm | Derives shared account state and actionable credentials |
| m-accounts-vm.test.ts | test | Tests shared account filtering and action gates |
| MHooksScreen.tsx | screen | Loads the hook registry and sheet selection |
| MHooksView.tsx | view | Grouped read-only hooks with declaration sheet |
| m-hooks-vm.ts | vm | Projects canonical hook namespace groups into read-only mobile slots |
| m-hooks-vm.test.ts | test | Tests mobile hook row/detail projection over shared grouping |
| MPlanReadScreen.tsx | screen | Loads a plan from the compact transcript and handles approve or reject |
| MPlanReadView.tsx | view | Full plan text with scroll progress and actions |
| MNotificationProvider.tsx | provider | Streams messages and notices into banners |
| MNotificationToaster.tsx | view | Stacked tappable top notification banners |
| MHotUpdateProvider.tsx | provider | Mounts the prompt when an update is staged |
| MHotUpdateDialog.tsx | view | Staged update alert with apply and ignore |
| MAppUpdateProvider.tsx | provider | Mounts the prompt when a shell update is ready |
| MAppUpdateDialog.tsx | view | Shell update alert with install, skip, later |
| m-connection.ts | util | Maps connection status to pill tone and pulse |
