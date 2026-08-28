Please update me when files in this folder change

Mobile screens use a data/routing Screen and pure View, plus a local or canonical feature model.
Shared semantics stay in features/design while mobile retains distinct visual components and interactions.

| filename | role | function |
|---|---|---|
| MChatScreen.tsx | screen | Composes compact chat, shared run status, interactions and neutral attachments |
| m-chat-attachments.ts | hook | Adapts mobile draft persistence to the neutral attachment controller |
| MChatInlineThreadCard.tsx | view | Binds the selected session's live inline thread stepper |
| MChatScreen.optimistic.test.tsx | test | Tests status priority, Todo wiring, optimistic sends and shortcuts |
| MChatView.tsx | view | Facades chat contracts and renders lazy subagents, decisions, turn-copy and screen frame |
| MChatView.types.ts | types | Shares public chat, action, composer and sheet contracts |
| MChatMessageActions.tsx | view | Renders success-only shared copy, long-press and edit actions |
| MChatAttachments.tsx | view | Renders transcript cards and queued/progress/retry/remove composer chips |
| MChatSheets.tsx | view | Renders session-id shared copy feedback plus profile/browser/context sheets |
| MChatComposerPresentation.tsx | view | Renders composer modes, tools, slash and plus menus |
| MChatView.test.tsx | test | Tests lazy detail, prompts, counts, Todo, ＋ menu and copy |
| m-chat-vm.ts | vm | Maps run facts with canonical USD labels and builds chat rows/profile/menu placement |
| m-chat-vm.test.ts | test | Tests localized run status, profile labels and row state |
| MInteractionCards.tsx | view | Ask-user bottom-input and plan-approval cards |
| MDecisionCards.tsx | view | Decision cards with bottom-sheet detail and responses |
| MSessionListScreen.tsx | screen | Binds sessions and the sentinel-safe editor-capable Scheduled sheet |
| MSessionListView.tsx | view | Day-grouped session rows with clock entry |
| MScheduleSheet.tsx | view | One compact list/runs/editor bottom-sheet state machine with level-aware back |
| MScheduleSheetLevels.tsx | view | Presents canonical-USD Scheduled list/run levels as DOM-stable components |
| MScheduleSheet.test.tsx | test | Tests real-DTO edits, one-sheet levels and pending-safe Escape/hardware-back reopen |
| MScheduleEditor.tsx | view | Composes shared-controller fields and honest once-edit limitations in-sheet |
| MScheduleEditorFields.tsx | view | Presents mobile schedule field groups as small DOM-stable components |
| m-session-list-vm.ts | vm | Groups sessions by day and derives status lines |
| m-session-list-vm.test.ts | test | Unit tests for the session list view model |
| MThreadsScreen.tsx | screen | Loads active and historical thread sections |
| MThreadsView.tsx | view | Grouped thread sections and wrapped pipelines |
| m-threads-vm.ts | vm | Derives canonical-USD budget, steps and task-linked card meta |
| m-threads-vm.test.ts | test | Tests mobile task-linked thread metadata |
| MThreadDetailScreen.tsx | screen | Adapts the shared lightweight detail controller to routing and document viewing |
| MThreadDetailView.tsx | view | Thread pipeline steps, artifacts and actions |
| MThreadDetailView.test.tsx | test | Unit tests for the cancel affordance |
| m-thread-detail-vm.ts | vm | Projects shared facts into mobile crumbs, artifacts, feeds and USD labels |
| m-thread-detail-vm.test.ts | test | Unit tests for the mobile thread detail projection |
| MTasksScreen.tsx | screen | Loads the project queue through canonical task grouping/order |
| MTasksView.tsx | view | Renders canonical task groups with mobile-specific blocker cards |
| MTaskDetailScreen.tsx | screen | Loads one task plus its verification evidence |
| MTaskDetailView.tsx | view | Task detail with blocker, fields, deps and history |
| m-task-detail-vm.ts | vm | Projects canonical task facts into the mobile read-only detail model |
| m-task-detail-vm.test.ts | test | Tests mobile blocker, approval, claim, completion and history projection |
| MProjectScreen.tsx | screen | Binds project data, shared note previews/add and scope-first creation |
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
| MNotesScreen.tsx | screen | Adapts the shared project-scoped notes resource into the mobile view |
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
| m-memory-file-vm.ts | vm | Derives basename and missing-aware canonical byte metadata |
| MMachinesScreen.tsx | screen | Adapts the shared machines resource to single expansion, navigation and approval feedback |
| MMachinesView.tsx | view | Keeps mobile-only expandable telemetry cards and Add action |
| MMachinesView.test.tsx | test | Tests collapsed and expanded panel gating |
| m-machines-vm.ts | vm | Maps machine records to cards and online counts |
| m-machines-vm.test.ts | test | Unit tests for the machines view model |
| MDaemonScreen.tsx | screen | Adapts the shared daemon resource while independently loading mobile execution and schedule summaries |
| MDaemonView.tsx | view | Shows canonical daemon tones with mobile long-press restart and disconnect controls |
| m-daemon-vm.ts | vm | Projects shared daemon facts into mobile fallback, summary and recent-event models |
| m-daemon-vm.test.ts | test | Tests shared process tones plus mobile fallback, summaries and recent events |
| MSettingsScreen.tsx | screen | Renders settings immediately from config and the shared machine roster |
| MSettingsView.tsx | view | Keeps Daemon and Profile cards above stable title-only rows |
| MSettingsView.test.tsx | test | Tests canonical order, routing and live connection copy |
| MSettingsControls.tsx | view | Supplies compact rows, toggles and field-local validation feedback |
| MPlatformScreen.tsx | screen | Shows redacted platform state and queues reconnect approval |
| MProfilesScreen.tsx | screen | Adapts the shared profile owner to the mobile list, native confirmation and editor view |
| MProfilesScreen.test.tsx | test | Tests mobile profile field errors and controller callback delegation |
| MBudgetScreen.tsx | screen | Keeps mobile budget view over pending-safe nullable shared-writer outcomes |
| MBudgetScreen.test.ts | test | Tests complete-pair initialization, pending gates and nullable operation feedback |
| MMcpScreen.tsx | screen | Lists configured MCP servers read-only |
| MRuntimeSettingsScreen.tsx | screen | Edits Notifications and keyed Advanced descriptors through the shared runtime writer |
| MRuntimeSettingsScreen.test.tsx | test | Tests descriptor-keyed Advanced rows, safe integer gating and writes |
| MAppearanceScreen.tsx | screen | Binds device-local appearance state and back route |
| MAppearanceView.tsx | view | Language, theme, palette, accent and motion controls |
| MAppearanceView.test.tsx | test | Tests mobile appearance control wiring |
| MUsageScreen.tsx | screen | Binds localized Usage thresholds, saves, refresh, and settings back route |
| MUsageView.tsx | view | Keeps drill header above usage controls |
| MUsageView.test.tsx | test | Tests status omission, row saves, config gating, and refresh |
| m-settings-vm.ts | vm | Maps canonical config, cost and registry summaries |
| m-settings-vm.test.ts | test | Tests runtime source and summary data mapping |
| MAccountsScreen.tsx | screen | Adapts shared account/custom-provider controllers to mobile navigation and sheets |
| MAccountsView.tsx | view | Preserves mobile account/custom-provider cards with operation-local action gates |
| MAccountsView.test.tsx | test | Tests mobile account permissions, pending actions and credential redaction |
| MAccountsView.custom.test.tsx | test | Tests mobile custom-provider actions, independent gates and delete confirmation |
| MCustomProviderSheet.tsx | view | Presents the shared custom-provider draft, error copy and save state in a bottom sheet |
| MHooksScreen.tsx | screen | Loads the hook registry and sheet selection |
| MHooksView.tsx | view | Grouped read-only hooks with declaration sheet |
| m-hooks-vm.ts | vm | Projects canonical hook namespace groups into read-only mobile slots |
| m-hooks-vm.test.ts | test | Tests mobile hook row/detail projection over shared grouping |
| MPlanReadScreen.tsx | screen | Loads a plan from the compact transcript and handles approve or reject |
| MPlanReadView.tsx | view | Full plan text with scroll progress and actions |
| MNotificationProvider.tsx | provider | Injects mobile route suppression and OS delivery into the shared feed, then deep-links actions |
| MNotificationProvider.test.tsx | test | Tests mobile permission, external delivery, deep-links and thin feed-adapter wiring |
| MNotificationToaster.tsx | view | Independently selects and renders stacked tappable top notification banners |
| MUpdateProvider.tsx | provider | Renders the one shared-priority mobile update prompt |
| MUpdateProvider.test.tsx | test | Verifies app/hot dialog selection and empty rendering |
| MUpdateFrame.tsx | view | Preserves alert chrome shared only by mobile update dialogs |
| MUpdateFrame.test.tsx | test | Characterizes mobile frame DOM, styles, icon and action slot |
| MUpdateDialogs.test.tsx | test | Preserves both mobile dialogs' copy, actions and button state |
| MHotUpdateDialog.tsx | view | Staged update apply/ignore content inside the mobile frame |
| MAppUpdateDialog.tsx | view | Shell update install/skip/later content inside the mobile frame |
| m-connection.ts | util | Maps connection status to pill tone and pulse |
