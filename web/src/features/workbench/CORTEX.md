Please update me when files in this folder change

The desktop workbench route: a three-pane frame of project rail, center chat and right work panel.
Views stay presentational, pure view models derive every row, and hooks bind live events and mutations.

| filename | role | function |
|---|---|---|
| WorkbenchPage.tsx | entry | Lays out rail, chat, preview and right panel |
| LeftRail.tsx | view | Project and session navigation rail |
| left-rail-projects.ts | vm | Builds ordered project rows with badges |
| left-rail-projects.test.ts | test | Unit tests for project row ordering |
| project-menu.ts | vm | Counts per-project running and attention badges |
| project-menu.test.ts | test | Unit tests for project menu counts |
| NewProjectModal.tsx | view | Creates a project from a validated name |
| new-project.ts | vm | Validates project names and maps create errors |
| new-project.test.ts | test | Unit tests for project name validation |
| session-groups.ts | vm | Groups sessions by day with unread first |
| session-groups.test.ts | test | Unit tests for session grouping |
| ProfileMenu.tsx | view | Lists selectable profiles with disabled reasons |
| profile-menu.ts | vm | Builds Claude/PI profile options and switch gates |
| profile-menu.test.ts | test | Tests Claude/PI profile menu options |
| CenterChat.tsx | view | Assembles chat header, stream and composer |
| ChatHeader.tsx | view | Session title, profile picker and run status |
| MessageStream.tsx | view | Scroll-stable transcript of chat rows and cards |
| ChatMarkdown.tsx | view | Renders assistant markdown with chat typography |
| ChatNotice.tsx | view | Info, warning and error notice boxes |
| ChatNotice.test.tsx | test | Unit tests for notice semantics |
| MessageEdit.tsx | view | Message hover actions, edit box and rewind |
| chat-content.ts | types | Tool call, attachment and slash command types |
| transcript-vm.ts | vm | Builds chat rows from transcript and live events |
| transcript-vm.test.ts | test | Unit tests for the transcript view model |
| ToolCallsRow.tsx | view | Collapsed tool chips that expand on click |
| tool-call-overflow.ts | util | Computes visible tool chips and hidden count |
| tool-call-overflow.test.ts | test | Unit tests for tool chip overflow |
| useToolCallOverflow.ts | hook | Measures chip widths and recomputes on resize |
| InteractionCards.tsx | view | Ask-user and plan-approval cards in the stream |
| interaction-vm.ts | vm | Maps interactions to card models and answer state |
| interaction-vm.test.ts | test | Unit tests for the interaction view model |
| useInteractionActions.ts | hook | Answers questions and responds to plan approvals |
| useInteractionTtl.ts | hook | Ticks remaining time until an interaction expires |
| PlanReadOverlay.tsx | view | Full plan text with progress and actions |
| plan-read-vm.ts | vm | Derives plan reading progress, status and meta |
| plan-read-vm.test.ts | test | Unit tests for the plan reading view model |
| InlineThreadCardProto.tsx | view | Live thread progress card inside the transcript |
| thread-card-proto.ts | vm | Maps thread detail to inline card rows and pill |
| thread-card-proto.test.ts | test | Unit tests for the inline thread card model |
| Composer.tsx | view | Message input with attachments and slash menu |
| ComposerStatusLine.tsx | view | Status row above the input with an accessory |
| composer-draft.ts | util | Persists and restores per-session drafts |
| composer-draft.test.ts | test | Unit tests for draft keys and parsing |
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
| useSessionMessageLiveSync.ts | hook | Streams live session events into chat state |
| useMarkSessionRead.ts | hook | Marks the visible session read |
| SessionIdModal.tsx | view | Shows session identifiers with copy actions |
| session-id.ts | vm | Builds identifier rows with a dash fallback |
| session-id.test.ts | test | Unit tests for identifier rows |
| RightPanel.tsx | view | Hosts thread, task and machine tabs with cost |
| right-panel-vm.ts | vm | Formats task-linked thread and machine metadata |
| right-panel-vm.test.ts | test | Tests task-linked thread and machine metadata |
| RightThreadCard.tsx | view | Contains expanded step activity rows within cards |
| RightThreadCard.layout.test.tsx | test | Browser-checks long subtask row containment |
| RightMachinesTab.tsx | view | Lists machines with status, GPUs and live runs |
| scope.ts | util | Maps active and history scope to status filters |
| scope.test.ts | test | Unit tests for scope filters |
| useThreadsLiveSync.ts | hook | Refreshes the thread list on thread events |
| useSessionsLiveSync.ts | hook | Refreshes the session list on lifecycle events |
| CurrentProjectProvider.tsx | provider | Shares the selected project across panes |
| current-project.ts | vm | Derives the effective current project id |
| current-project.test.ts | test | Unit tests for current project derivation |
| SelectedSessionProvider.tsx | provider | Shares selected and draft session across panes |
| selected-session.ts | vm | Resolves selected session and transition profile |
| selected-session.test.ts | test | Unit tests for session selection |
| DaemonStatusModal.tsx | view | Daemon and server processes with restart |
| DebugDetailsModal.tsx | view | Inspector dialog for raw tool input and result |
| debug-inspector.test.tsx | test | Unit tests for the inspector value helpers |
