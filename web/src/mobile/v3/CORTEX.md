Please update me when files in this folder change

Every mobile screen as a triad: a Screen container binding data and routing, a pure View, and a view model.
The view models are framework-free record to slot mappings and each one has a colocated unit test.

| filename | role | function |
|---|---|---|
| MChatScreen.tsx | screen | Routes chat data, sends and local slash actions |
| MChatScreen.optimistic.test.tsx | test | Tests optimistic sends and local shortcuts |
| MChatView.tsx | view | Renders chat, formula replies, composer and sheets |
| MChatView.test.tsx | test | Tests chat, slash and interaction controls |
| m-chat-vm.ts | vm | Chat rows, status, attachments, menu placement |
| m-chat-vm.test.ts | test | Unit tests for the chat view model |
| MInteractionCards.tsx | view | Ask-user and plan-approval cards for chat |
| MSessionListScreen.tsx | screen | Binds sessions, schedules and the Scheduled sheet |
| MSessionListView.tsx | view | Day-grouped session rows with clock entry |
| MScheduleSheet.tsx | view | Scheduled bottom sheet with run drill-down |
| m-session-list-vm.ts | vm | Groups sessions by day and derives status lines |
| m-session-list-vm.test.ts | test | Unit tests for the session list view model |
| MThreadsScreen.tsx | screen | Loads active and historical thread sections |
| MThreadsView.tsx | view | Grouped thread sections and wrapped pipelines |
| MThreadsView.test.tsx | test | Tests sections, header and pipeline containment |
| m-threads-vm.ts | vm | Derives budget, steps and task-linked card meta |
| m-threads-vm.test.ts | test | Tests mobile task-linked thread metadata |
| MThreadDetailScreen.tsx | screen | Binds routed mobile detail and cancellation |
| MThreadDetailView.tsx | view | Thread pipeline steps, artifacts and actions |
| MThreadDetailView.test.tsx | test | Unit tests for the cancel affordance |
| m-thread-detail-vm.ts | vm | Maps thread detail to steps, crumbs, artifacts |
| m-thread-detail-vm.test.ts | test | Unit tests for the thread detail view model |
| MTasksScreen.tsx | screen | Loads the complete project task queue |
| MTasksView.tsx | view | Renders sections with one-line blocker details |
| MTasksView.test.tsx | test | Tests complete list and blocker truncation |
| m-tasks-vm.ts | vm | Orders non-empty lifecycle task groups |
| m-tasks-vm.test.ts | test | Tests complete lifecycle group order |
| MTaskDetailScreen.tsx | screen | Loads one task plus its verification evidence |
| MTaskDetailView.tsx | view | Task detail with blocker, fields, deps and history |
| MTaskDetailView.test.tsx | test | Guards blocker, approval and dependency state |
| m-task-detail-vm.ts | vm | Maps task blocker, claim and verification state |
| m-task-detail-vm.test.ts | test | Tests blocker, approval, claim and detail state |
| MProjectScreen.tsx | screen | Binds project, notes, cost and scoped approvals |
| MProjectView.tsx | view | Project-scoped tab with settings gear and switcher |
| m-project-vm.ts | vm | Derives thread counts, approval buckets, switch rows |
| m-project-vm.test.ts | test | Unit tests for the project view model |
| MNewProjectView.tsx | view | New-project sheet with name input and create |
| MNewProjectView.test.tsx | test | Unit tests for create gating in the sheet |
| m-new-project-vm.ts | vm | Create-gate predicate and copy for the sheet |
| m-new-project-vm.test.ts | test | Unit tests for the new project view model |
| MApprovalsScreen.tsx | screen | Binds approvals list, approve and reject |
| MApprovalsView.tsx | view | Project-grouped queue with expandable decision card |
| m-approvals-vm.ts | vm | Groups pending approvals by project into card slots |
| m-approvals-vm.test.ts | test | Unit tests for the approvals view model |
| MIssuesScreen.tsx | screen | Binds issue list, delete and handle flow |
| MIssuesView.tsx | view | Issue cards with inline delete and handle |
| m-issues-vm.ts | vm | Maps issue records to cards with body fields |
| m-issues-vm.test.ts | test | Unit tests for the issues view model |
| MNotesScreen.tsx | screen | Binds private note queries and mutations |
| MNotesView.tsx | view | Lists tappable notes with swipe delete and input |
| MNotesView.test.tsx | test | Tests tap, swipe and full-page presentation |
| MNotesProjectCard.tsx | view | Adds and previews notes on Projects |
| MNotesProjectCard.test.tsx | test | Tests the persistent zero-count entry |
| m-notes-vm.ts | vm | Groups notes and limits card previews |
| m-notes-vm.test.ts | test | Tests note counts, groups and local time |
| m-notes-gestures.ts | util | Resolves swipe and post-drag click suppression |
| m-notes-gestures.test.ts | test | Tests tap and swipe gesture thresholds |
| MMemoryScreen.tsx | screen | Binds the memory tree and accordion state |
| MMemoryView.tsx | view | Core files and directory accordions |
| m-memory-vm.ts | vm | Maps the memory tree to rows and cards |
| m-memory-vm.test.ts | test | Unit tests for the memory view model |
| MMemoryFileScreen.tsx | screen | Binds one memory file by path parameter |
| MMemoryFileView.tsx | view | Read-only markdown file with header metaline |
| m-memory-file-vm.ts | vm | Derives basename, byte size and metaline |
| m-memory-file-vm.test.ts | test | Unit tests for the memory file view model |
| MMachinesScreen.tsx | screen | Binds the machine list, expand state and probe |
| MMachinesView.tsx | view | Expandable machine cards with probe telemetry |
| MMachinesView.test.tsx | test | Tests collapsed and expanded panel gating |
| m-machines-vm.ts | vm | Maps machine records to cards and online counts |
| m-machines-vm.test.ts | test | Unit tests for the machines view model |
| MDaemonScreen.tsx | screen | Binds daemon status, counts and restart |
| MDaemonView.tsx | view | Shows daemon processes, restart and disconnect controls |
| MDaemonView.test.tsx | test | Tests disconnect action layout |
| m-daemon-vm.ts | vm | Builds daemon process, summary and event models |
| m-daemon-vm.test.ts | test | Unit tests for the daemon view model |
| MSettingsScreen.tsx | screen | Loads settings and account summary data |
| MSettingsView.tsx | view | Fixed-header settings with account and config drill-ins |
| MSettingsView.test.tsx | test | Tests fixed header and settings drill-in rows |
| m-settings-vm.ts | vm | Maps config, costs and mounted hooks |
| m-settings-vm.test.ts | test | Tests mobile settings data mapping |
| MAccountsScreen.tsx | screen | Loads account status and serializes logout actions |
| MAccountsView.tsx | view | Groups provider cards with gated account actions |
| MAccountsView.test.tsx | test | Tests mobile account groups and pending actions |
| MAccountsView.custom.test.tsx | test | Tests the custom provider section and delete guard |
| MCustomProviderSheet.tsx | view | Bottom-sheet editor for one custom PI provider |
| m-accounts-vm.ts | vm | Derives shared account state and actionable credentials |
| m-accounts-vm.test.ts | test | Tests shared account filtering and action gates |
| MHooksScreen.tsx | screen | Loads the hook registry and sheet selection |
| MHooksView.tsx | view | Grouped read-only hooks with declaration sheet |
| MHooksView.test.tsx | test | Tests hook grouping, flags and the sheet |
| m-hooks-vm.ts | vm | Groups hooks by namespace into read-only slots |
| m-hooks-vm.test.ts | test | Unit tests for the hooks view model |
| MPlanReadScreen.tsx | screen | Loads a plan and handles approve or reject |
| MPlanReadView.tsx | view | Full plan text with scroll progress and actions |
| MNotificationProvider.tsx | provider | Streams messages and notices into banners |
| MNotificationToaster.tsx | view | Stacked tappable top notification banners |
| MHotUpdateProvider.tsx | provider | Mounts the prompt when an update is staged |
| MHotUpdateDialog.tsx | view | Staged update alert with apply and ignore |
| MAppUpdateProvider.tsx | provider | Mounts the prompt when a shell update is ready |
| MAppUpdateDialog.tsx | view | Shell update alert with install, skip, later |
| m-connection.ts | util | Maps connection status to pill tone and pulse |
| m-connection.test.ts | test | Unit tests for the connection status mapping |
