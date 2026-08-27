Please update me when files in this folder change

The desktop workbench route: a three-pane frame of project rail, center chat and right work panel.
Views stay presentational, pure view models derive every row, and hooks bind live events and mutations.

| filename | role | function |
|---|---|---|
| WorkbenchPage.tsx | entry | Composes panes and global workbench actions |
| LeftRail.tsx | view | Collapsible project, session and SCHEDULED navigation zones |
| left-rail-projects.ts | vm | Builds ordered project rows with badges |
| left-rail-projects.test.ts | test | Tests project activity ordering, hotkeys and attention counts |
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
| ProfileMenu.tsx | view | Lists compact profiles above or below its anchor |
| profile-menu.ts | vm | Filters live profile options and switch gates |
| profile-menu.test.ts | test | Tests live profile filtering and switch gates |
| SessionProfileSelector.tsx | view | Shows a mobile-colored desktop profile selector |
| SessionProfileSelector.test.tsx | test | Tests profile routing, selection and chip chrome |
| CenterChat.tsx | view | Reconciles chat state, startup progress and composer placement |
| scheduled-chat.ts | vm | Cadence label and next-run delta helpers |
| ChatHeader.tsx | view | Session title, command, browser, notes and session menu |
| MessageStream.tsx | view | Renders transcript, centered HTML views and message actions |
| ChatMarkdown.tsx | view | Renders Markdown with width-bounded KaTeX formulas |
| ChatMarkdown.test.tsx | test | Tests formula parsing, opt-in behavior and untrusted-input safety |
| ChatNotice.tsx | view | Localized semantic notices with optional actions |
| ChatNotice.test.tsx | test | Tests semantic roles, action gating and safe auth activation |
| MessageEdit.tsx | view | Bare message actions, edit box and rewind |
| chat-content.ts | types | Defines chat types and local shortcut catalog |
| transcript-vm.ts | vm | Builds day-grouped chat rows and turn-copy targets |
| transcript-vm.test.ts | test | Tests transcript rows, turn copy and auth actions |
| ToolCallsRow.tsx | view | Expands tool chips and lazy-loads DEBUG details |
| SubagentBlock.tsx | view | Shows prompt rows with a right-aligned tool count |
| SubagentBlock.test.tsx | test | Tests prompt disclosure and count alignment |
| tool-call-overflow.ts | util | Computes bounded visible and hidden tool counts |
| tool-call-overflow.test.ts | test | Tests counts beyond the measured chip prefix |
| useToolCallOverflow.ts | hook | Measures a bounded chip prefix on resize |
| InteractionCards.tsx | view | Ask-user and plan-approval cards in the stream |
| interaction-vm.ts | vm | Maps interactions to card models and answer state |
| interaction-vm.test.ts | test | Unit tests for the interaction view model |
| useInteractionActions.ts | hook | Answers questions and responds to plan approvals |
| useInteractionTtl.ts | hook | Ticks remaining time until an interaction expires |
| PlanReadOverlay.tsx | view | Full plan text with progress and actions |
| plan-read-vm.ts | vm | Derives plan reading progress, status and meta |
| plan-read-vm.test.ts | test | Tests read-progress arithmetic and clamping |
| InlineThreadCardProto.tsx | view | Live thread card opening modal detail |
| thread-card-proto.ts | vm | Maps thread detail to inline card rows and pill |
| thread-card-proto.test.ts | test | Unit tests for the inline thread card model |
| Composer.tsx | view | Mobile-aligned input card with startup and run status |
| Composer.test.tsx | test | Tests shortcuts, input chrome, startup and failed sends |
| ComposerActionRow.tsx | view | Toolbar row: ＋ menu and browser capsule left, profile/context/send right |
| BrowserOptIn.tsx | model | Browser device options for the composer ＋ menu |
| browser-status.ts | model | Phrases browser takeover and turn-start hints |
| browser-status.test.ts | test | Tests takeover and startup hint states |
| ComposerActionRow.test.tsx | test | Tests ＋-menu actions, browser page/capsule and slash menu |
| ComposerStatusLine.tsx | view | Status line of running/idle meta below the composer |
| composer-draft.ts | util | Persists, restores and prefills drafts |
| composer-draft.test.ts | test | Tests draft keys, parsing and send restoration |
| optimistic-message.ts | vm | Reconciles local sends with source-aware message evidence |
| useOptimisticUserMessages.ts | hook | Holds the shared optimistic-send lifecycle for both chats |
| optimistic-message.test.ts | test | Tests stale rows, de-duplication and failure |
| optimistic-message.integration.test.tsx | test | Tests mounted pending sends, restoration and authority races |
| composer-slash.ts | util | Resolves shared UI-local slash actions |
| composer-slash.test.ts | test | Tests shortcut parsing, availability and local dispatch |
| ContextUsageControl.tsx | view | Context usage ring, details and compact action |
| TodoRail.tsx | shared | Shows composer Todo summary or click-to-collapse list |
| TodoRail.test.tsx | test | Tests expanded task-list interaction |
| todo-vm.ts | vm | Validates task snapshots and builds rail rows |
| todo-vm.test.ts | test | Tests payload validation, resolution and rail rows |
| ContextUsageControl.test.tsx | test | Unit tests for context control visibility |
| context-usage.ts | vm | Resolves context snapshots into labels and bars |
| context-usage.test.ts | test | Tests snapshot validation, precedence and progress state |
| useSessionCompact.ts | hook | Runs manual context compaction |
| useAssistantDeltaStream.ts | hook | Subscribes to token deltas for one session |
| useRevealedText.ts | hook | Drives the frame loop revealing streamed text |
| reveal-pacing.ts | util | Computes how much streamed text to show |
| reveal-pacing.test.ts | test | Unit tests for reveal pacing |
| useSessionMessageLiveSync.ts | hook | Streams session-scoped messages and runtime snapshots |
| useSessionMessageLiveSync.test.tsx | test | Tests message authority and Todo isolation |
| useSessionsLiveSync.test.tsx | test | Tests rail-wide session snapshot refresh |
| useMarkSessionRead.ts | hook | Marks the visible session read |
| SessionIdModal.tsx | view | Shows session identifiers with copy actions |
| session-id.ts | vm | Builds identifier rows with a dash fallback |
| PaneToggle.tsx | view | Chevron button collapsing either side pane, mirrored per side |
| RightPanel.tsx | view | Animates scoped work tabs or notes into an icon rail |
| right-panel-vm.ts | vm | Formats budget, thread and machine metadata |
| right-panel-vm.test.ts | test | Tests budget, thread and machine view models |
| RightThreadCard.tsx | view | Opens run, task and thread details from activity rows |
| RightThreadCard.test.tsx | test | Tests waiting-task click delegation |
| RightMachinesTab.tsx | view | Expandable machine cards with live probe telemetry |
| machine-detail-vm.ts | vm | Maps the machine probe to meters, GPU and run rows |
| machine-detail-vm.test.ts | test | Tests machine meters, GPU ownership, process bounds and probe errors |
| scope.ts | util | Groups active and historical threads |
| scope.test.ts | test | Tests fixed thread lifecycle groups |
| useRecentNow.ts | hook | Ticks recent lists once per minute |
| useRecentNow.test.ts | test | Tests recent-list timer and cleanup |
| useThreadsLiveSync.ts | hook | Refreshes the thread list on thread events |
| useSessionsLiveSync.ts | hook | Refreshes the session list on lifecycle events |
| useProjectSessions.ts | hook | Selects project sessions from shared origin caches |
| useProjectSessions.test.ts | test | Tests shared session project projection |
| CurrentProjectProvider.tsx | provider | Shares the selected project across panes |
| current-project.ts | vm | Derives the effective current project id |
| current-project.test.ts | test | Unit tests for current project derivation |
| SelectedSessionProvider.tsx | provider | Shares sessions and external draft prefill |
| selected-session.ts | vm | Resolves selected session and transition profile |
| selected-session.test.ts | test | Unit tests for session selection |
| DaemonStatusModal.tsx | view | Daemon and server processes, frontend build stamp and restart |
| DebugDetailsModal.tsx | view | Inspector dialog with scoped hover controls |
| debug-inspector.test.tsx | test | Tests hover scope, counting and debug formatting |
