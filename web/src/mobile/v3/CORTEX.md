Please update me when files in this folder change

Every mobile screen as a triad: a Screen container binding data and routing, a pure View, and a view model.
The view models are framework-free record to slot mappings and each one has a colocated unit test.

| filename | role | function |
|---|---|---|
| MChatScreen.tsx | screen | Owns chat data, live sync and sending |
| MChatView.tsx | view | Chat stream, header, composer and sheets |
| MChatView.test.tsx | test | Tests chat controls and interaction layout |
| m-chat-vm.ts | vm | Builds chat rows, status and attachment models |
| m-chat-vm.test.ts | test | Unit tests for the chat view model |
| MInteractionCards.tsx | view | Ask-user and plan-approval cards for chat |
| MSessionListScreen.tsx | screen | Fetches project direct sessions for the tab |
| MSessionListView.tsx | view | Day-grouped session rows with status dots |
| m-session-list-vm.ts | vm | Groups sessions by day and derives status lines |
| m-session-list-vm.test.ts | test | Unit tests for the session list view model |
| MThreadsScreen.tsx | screen | Loads project threads, detail and cost |
| MThreadsView.tsx | view | Threads header and drill-in pipeline cards |
| m-threads-vm.ts | vm | Derives budget, steps and task-linked card meta |
| m-threads-vm.test.ts | test | Tests mobile task-linked thread metadata |
| MThreadDetailScreen.tsx | screen | Binds routed mobile detail and cancellation |
| MThreadDetailView.tsx | view | Thread pipeline steps, artifacts and actions |
| MThreadDetailView.test.tsx | test | Unit tests for the cancel affordance |
| m-thread-detail-vm.ts | vm | Maps thread detail to steps, crumbs, artifacts |
| m-thread-detail-vm.test.ts | test | Unit tests for the thread detail view model |
| MTasksScreen.tsx | screen | Loads project tasks and owns segment state |
| MTasksView.tsx | view | Grouped task list with executable and all views |
| m-tasks-vm.ts | vm | Selects and orders task groups per segment |
| m-tasks-vm.test.ts | test | Unit tests for the tasks view model |
| MTaskDetailScreen.tsx | screen | Loads one task plus its verification evidence |
| MTaskDetailView.tsx | view | Task detail with real fields, deps and history |
| MTaskDetailView.test.tsx | test | Guards task fields and dependency empty state |
| m-task-detail-vm.ts | vm | Maps task and verification records to a model |
| m-task-detail-vm.test.ts | test | Unit tests for the task detail view model |
| MProjectScreen.tsx | screen | Binds project, cost and connectivity data |
| MProjectView.tsx | view | Projects tab with status, budget and switcher |
| m-project-vm.ts | vm | Derives thread counts, machines and switch rows |
| m-project-vm.test.ts | test | Unit tests for the project view model |
| MNewProjectView.tsx | view | New-project sheet with name input and create |
| MNewProjectView.test.tsx | test | Unit tests for create gating in the sheet |
| m-new-project-vm.ts | vm | Create-gate predicate and copy for the sheet |
| m-new-project-vm.test.ts | test | Unit tests for the new project view model |
| MApprovalsScreen.tsx | screen | Binds approvals list, approve and reject |
| MApprovalsView.tsx | view | Approval queue with expandable decision card |
| m-approvals-vm.ts | vm | Maps pending approval records to card slots |
| m-approvals-vm.test.ts | test | Unit tests for the approvals view model |
| MIssuesScreen.tsx | screen | Binds issue list, delete and handle flow |
| MIssuesView.tsx | view | Issue cards with inline delete and handle |
| m-issues-vm.ts | vm | Maps issue records to cards with body fields |
| m-issues-vm.test.ts | test | Unit tests for the issues view model |
| MMemoryScreen.tsx | screen | Binds the memory tree and accordion state |
| MMemoryView.tsx | view | Core files and directory accordions |
| m-memory-vm.ts | vm | Maps the memory tree to rows and cards |
| m-memory-vm.test.ts | test | Unit tests for the memory view model |
| MMemoryFileScreen.tsx | screen | Binds one memory file by path parameter |
| MMemoryFileView.tsx | view | Read-only markdown file with header metaline |
| m-memory-file-vm.ts | vm | Derives basename, byte size and metaline |
| m-memory-file-vm.test.ts | test | Unit tests for the memory file view model |
| MMachinesScreen.tsx | screen | Binds the machine registry list and back nav |
| MMachinesView.tsx | view | Machine cards with online and heartbeat state |
| m-machines-vm.ts | vm | Maps machine records to cards and online counts |
| m-machines-vm.test.ts | test | Unit tests for the machines view model |
| MDaemonScreen.tsx | screen | Binds daemon status, counts and restart |
| MDaemonView.tsx | view | Daemon processes, restart controls and events |
| m-daemon-vm.ts | vm | Builds daemon process, summary and event models |
| m-daemon-vm.test.ts | test | Unit tests for the daemon view model |
| MSettingsScreen.tsx | screen | Loads config and cost, writes the profile |
| MSettingsView.tsx | view | Rows for profile, theme, budget and toggles |
| m-settings-vm.ts | vm | Maps config and cost into settings row values |
| m-settings-vm.test.ts | test | Unit tests for the settings view model |
| MPlanReadScreen.tsx | screen | Loads a plan and handles approve or reject |
| MPlanReadView.tsx | view | Full plan text with scroll progress and actions |
| MNotificationProvider.tsx | provider | Streams messages and notices into banners |
| MNotificationToaster.tsx | view | Stacked tappable top notification banners |
| MHotUpdateProvider.tsx | provider | Mounts the prompt when an update is staged |
| MHotUpdateDialog.tsx | view | Staged update alert with apply and ignore |
| m-connection.ts | util | Maps connection status to pill tone and pulse |
| m-connection.test.ts | test | Unit tests for the connection status mapping |
