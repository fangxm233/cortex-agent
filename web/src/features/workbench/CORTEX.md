Please update me when files in this folder change

The desktop workbench route: a three-pane frame of project rail, center chat and right work panel.
Views stay presentational, pure view models derive every row, and hooks bind live events and mutations.

| filename | role | function |
|---|---|---|
| WorkbenchPage.tsx | entry | Lays out rail, chat, preview and right panel |
| LeftRail.tsx | view | Project, session and SCHEDULED-section navigation rail |
| left-rail-projects.ts | vm | Builds ordered project rows with badges |
| left-rail-projects.test.ts | test | Unit tests for project row ordering |
| project-menu.ts | vm | Counts per-project running and attention badges |
| project-menu.test.ts | test | Unit tests for project menu counts |
| NewProjectModal.tsx | view | Creates a project from a validated name |
| new-project.ts | vm | Validates project names and maps create errors |
| new-project.test.ts | test | Unit tests for project name validation |
| session-groups.ts | vm | Day-groups sessions with meta and stamp helpers |
| session-groups.test.ts | test | Unit tests for session day grouping |
| schedule-rail.ts | vm | Builds SCHEDULED rows, run ordinals and click routing |
| schedule-rail.test.ts | test | Unit tests for the SCHEDULED section view model |
| RunListModal.tsx | view | Run-list modal opening a run in the chat pane |
| ProfileMenu.tsx | view | Lists profiles above or below its anchor |
| profile-menu.ts | vm | Filters live profile options and switch gates |
| profile-menu.test.ts | test | Tests live profile filtering and switch gates |
| SessionProfileSelector.tsx | view | Selects draft or live profiles from the composer |
| SessionProfileSelector.test.tsx | test | Tests profile routing and menu placement |
| CenterChat.tsx | view | Reconciles transcript, live and optimistic chat rows |
| scheduled-chat.ts | vm | Cadence label and next-run delta helpers |
| scheduled-chat.test.ts | test | Unit tests for scheduled-chat helpers |
| ChatHeader.tsx | view | Session title, command, notes and session menu |
| ChatHeader.test.tsx | test | Tests removal of profile and status controls |
| MessageStream.tsx | view | Scroll-stable transcript with actionable notices |
| ChatMarkdown.tsx | view | Renders assistant markdown with chat typography |
| ChatNotice.tsx | view | Semantic notice boxes with optional auth actions |
| ChatNotice.test.tsx | test | Tests notice semantics and auth activation |
| MessageEdit.tsx | view | Message hover actions, edit box and rewind |
| chat-content.ts | types | Tool call, attachment and slash command types |
| transcript-vm.ts | vm | Builds chat rows and strips the schedule prefix |
| transcript-vm.test.ts | test | Tests transcript rows and auth action retention |
| ToolCallsRow.tsx | view | Collapsed tool chips that expand on click |
| tool-call-overflow.ts | util | Computes visible tool chips and hidden count |
| tool-call-overflow.test.ts | test | Unit tests for tool chip overflow |
| useToolCallOverflow.ts | hook | Measures chip widths and recomputes on resize |
| InteractionCards.tsx | view | Ask-user and plan-approval cards in the stream |
| InteractionCards.test.tsx | test | Unit tests for ask-card severity badges |
| interaction-vm.ts | vm | Maps interactions to card models and answer state |
| interaction-vm.test.ts | test | Unit tests for the interaction view model |
| useInteractionActions.ts | hook | Answers questions and responds to plan approvals |
| useInteractionTtl.ts | hook | Ticks remaining time until an interaction expires |
| PlanReadOverlay.tsx | view | Full plan text with progress and actions |
| plan-read-vm.ts | vm | Derives plan reading progress, status and meta |
| plan-read-vm.test.ts | test | Unit tests for the plan reading view model |
| InlineThreadCardProto.tsx | view | Live thread card opening modal detail |
| thread-card-proto.ts | vm | Maps thread detail to inline card rows and pill |
| thread-card-proto.test.ts | test | Unit tests for the inline thread card model |
| Composer.tsx | view | Guards sends and restores rejected drafts |
| Composer.test.tsx | test | Tests the visible rejected-send state |
| ComposerActionRow.tsx | view | Groups profile, attach and command controls |
| ComposerActionRow.test.tsx | test | Tests shared-row layout and callbacks |
| ComposerStatusLine.tsx | view | Status row above the input with an accessory |
| composer-draft.ts | util | Persists, restores and prefills drafts |
| composer-draft.test.ts | test | Tests draft keys, parsing and send restoration |
| optimistic-message.ts | vm | Reconciles local sends with source-aware message evidence |
| useOptimisticUserMessages.ts | hook | Holds the shared optimistic-send lifecycle for both chats |
| optimistic-message.test.ts | test | Tests stale rows, de-duplication and failure |
| optimistic-message.integration.test.tsx | test | Tests pending sends and authority races |
| composer-slash.ts | util | Resolves a slash-menu pick into a command |
| composer-slash.test.ts | test | Unit tests for slash command dispatch |
| ContextUsageControl.tsx | view | Context usage bar, details and compact action |
| ContextUsageControl.test.tsx | test | Unit tests for context control visibility |
| context-usage.ts | vm | Resolves context snapshots into labels and bars |
| context-usage.test.ts | test | Unit tests for context usage resolution |
| useSessionCompact.ts | hook | Runs manual context compaction |
| useAssistantDeltaStream.ts | hook | Subscribes to token deltas for one session |
| useRevealedText.ts | hook | Drives the frame loop revealing streamed text |
| reveal-pacing.ts | util | Computes how much streamed text to show |
| reveal-pacing.test.ts | test | Unit tests for reveal pacing |
| useSessionMessageLiveSync.ts | hook | Streams messages with notice action metadata |
| useSessionMessageLiveSync.test.tsx | test | Tests message authority and auth action retention |
| useMarkSessionRead.ts | hook | Marks the visible session read |
| SessionIdModal.tsx | view | Shows session identifiers with copy actions |
| session-id.ts | vm | Builds identifier rows with a dash fallback |
| session-id.test.ts | test | Unit tests for identifier rows |
| RightPanel.tsx | view | Hosts scoped budget, work tabs, or notes |
| right-panel-vm.ts | vm | Formats budget, thread and machine metadata |
| right-panel-vm.test.ts | test | Tests budget, thread and machine view models |
| RightThreadCard.tsx | view | Opens run, task and thread details from activity rows |
| RightThreadCard.test.tsx | test | Tests waiting-task click delegation |
| RightThreadCard.layout.test.tsx | test | Browser-checks long subtask row containment |
| RightMachinesTab.tsx | view | Expandable machine cards with live probe telemetry |
| machine-detail-vm.ts | vm | Maps the machine probe to meters, GPU and run rows |
| machine-detail-vm.test.ts | test | Tests machine meters, GPU owners and formatters |
| scope.ts | util | Groups active and historical threads |
| scope.test.ts | test | Tests fixed thread lifecycle groups |
| useRecentNow.ts | hook | Ticks recent lists once per minute |
| useRecentNow.test.ts | test | Tests recent-list timer and cleanup |
| useThreadsLiveSync.ts | hook | Refreshes the thread list on thread events |
| useSessionsLiveSync.ts | hook | Refreshes the session list on lifecycle events |
| CurrentProjectProvider.tsx | provider | Shares the selected project across panes |
| current-project.ts | vm | Derives the effective current project id |
| current-project.test.ts | test | Unit tests for current project derivation |
| SelectedSessionProvider.tsx | provider | Shares sessions and external draft prefill |
| selected-session.ts | vm | Resolves selected session and transition profile |
| selected-session.test.ts | test | Unit tests for session selection |
| DaemonStatusModal.tsx | view | Daemon and server processes with restart |
| DebugDetailsModal.tsx | view | Inspector dialog for raw tool input and result |
| debug-inspector.test.tsx | test | Tests inspector values and nested dialog layer |
