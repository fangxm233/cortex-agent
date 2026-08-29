Please update me when files in this folder change

The desktop workbench route: a three-pane frame of project rail, center chat and right work panel.
Views stay presentational, pure view models derive every row, and hooks bind live events and mutations.

| filename | role | function |
|---|---|---|
| WorkbenchPage.tsx | entry | Composes panes and global workbench actions |
| LeftRail.tsx | view | Frames the project tree and publishes its rendered project order |
| RailTree.tsx | view | Renders project folders with their sessions, schedules and commission folders |
| rail-tree.ts | vm | Builds project folder nodes with session, schedule and commission rows |
| rail-tree.test.ts | test | Tests folder ordering, capping, filtering, commission grouping and badges |
| rail-order.ts | vm | Persists the rail's manual and activity project order |
| rail-order.test.ts | test | Tests order reconciliation, moves and mode resolution |
| ProjectFolderIcon.tsx | view | Draws the open or closed project folder glyph |
| left-rail-projects.ts | vm | Relative ages, activity order and the hotkey index |
| left-rail-projects.test.ts | test | Tests project activity ordering, ages and hotkeys |
| project-menu.ts | vm | Counts per-project running and attention badges |
| project-menu.test.ts | test | Unit tests for project menu counts |
| NewProjectModal.tsx | view | Presents desktop creation in the shared accessible bare dialog through the projects controller |
| session-groups.ts | vm | Day-groups sessions with meta and stamp helpers |
| session-groups.test.ts | test | Tests SessionInfo-aware day grouping |
| commission-rail.ts | vm | Builds COMMISSION rows with member sessions, signal rollup and open-first ordering |
| commission-rail.test.ts | test | Tests commission membership, rollup, ordering and title fallback |
| schedule-rail.ts | vm | Builds SCHEDULED rows, shared-USD costs, run ordinals and real ScheduleInfo edit actions |
| schedule-rail.test.ts | test | Tests SessionInfo grouping, ordinals and edit routing |
| RunListModal.tsx | view | Accessible bare run-list dialog with canonical USD costs and schedule-manage handoff |
| WorkbenchModals.test.tsx | test | Guards SessionInfo-backed modal actions and dismissal |
| ProfileMenu.tsx | view | Lists compact profiles above or below its anchor |
| profile-menu.ts | vm | Filters live profile options and switch gates |
| profile-menu.test.ts | test | Tests live profile filtering and switch gates |
| SessionProfileSelector.tsx | view | Shares guarded profile state with composer controls |
| SessionProfileSelector.test.tsx | test | Tests profile routing and selection interactions |
| DraftProjectSelector.tsx | view | Profile-styled draft project chip ordered like the left rail |
| DraftProjectSelector.test.tsx | test | Tests capsule style, rail order, switching and pending lock |
| CenterChat.tsx | view | Reconciles compact chat state, startup progress and composer placement |
| scheduled-chat.ts | vm | Cadence label and next-run delta helpers |
| ChatHeader.tsx | view | Session title, command, browser, notes and session menu |
| MessageStream.tsx | view | Renders transcript rows, controls and scroll pinning |
| MessageAttachmentCards.tsx | view | Renders user and agent attachment, media, file and HTML-view cards |
| DecisionCards.tsx | view | Gates decision response actions behind in-place expansion |
| DecisionCards.test.tsx | test | Tests disclosure-only actions and composed response messages |
| decision-vm.ts | vm | Derives decision status and composes the explain and revise messages |
| decision-vm.test.ts | test | Tests status precedence and message templating |
| attachment-presentation.ts | util | Adapts canonical byte labels plus attachment extension and semantic colors |
| ChatMarkdown.tsx | view | Renders Markdown with width-bounded KaTeX formulas |
| ChatMarkdown.test.tsx | test | Tests formula parsing, opt-in behavior and untrusted-input safety |
| ChatNotice.tsx | view | Localized semantic notices with optional actions |
| ChatNotice.test.tsx | test | Tests semantic roles, action gating and safe auth activation |
| MessageEdit.tsx | view | Bare message actions with success-only clipboard feedback, edit box and rewind |
| chat-content.ts | types | Defines workbench tool-call types and the local shortcut catalog |
| transcript-vm.ts | vm | Builds compact decision-aware rows over neutral attachments and turn-copy targets |
| transcript-vm.test.ts | test | Tests compact rows, turn tails, auth actions and decisions |
| ToolCallsRow.tsx | view | Expands tool chips with row-scoped debug actions |
| SubagentBlock.tsx | view | Shows prompt rows with a right-aligned tool count |
| SubagentTranscriptDetail.tsx | view | Lazily loads one subagent transcript with minimal retry UI |
| SubagentBlock.test.tsx | test | Tests prompt disclosure and nested copy isolation |
| SubagentTranscriptDetail.test.tsx | test | Tests expansion-gated detail queries and retry states |
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
| thread-card-proto.ts | vm | Maps thread detail to inline card rows, canonical USD labels and pill |
| thread-card-proto.test.ts | test | Unit tests for the inline thread card model |
| Composer.tsx | view | Adapts project-scoped drafts and inputs to uploads and shared run status |
| session-run-status.ts | vm | Derives locale-free foreground, background, idle and fresh session facts |
| session-run-status.test.ts | test | Tests run phases, active tone, metrics and finalized-cost visibility |
| ComposerAttachmentChip.tsx | view | Renders queued, uploading, failed, and done neutral attachment items with retry/remove controls |
| ComposerSendFailure.tsx | view | Presents localized rejected-send draft restoration feedback |
| Composer.test.tsx | test | Tests shortcuts, browser/background status and rejected sends |
| ComposerActionRow.tsx | view | Toolbar row: ＋ menu and browser capsule left, profile/context/send right |
| BrowserOptIn.tsx | model | Browser device options for the composer ＋ menu |
| CommissionOptIn.tsx | model | Commission-mode options for the composer ＋ menu, and the live session's capsule |
| browser-status.ts | model | Phrases browser takeover and turn-start hints |
| browser-status.test.ts | test | Tests takeover and startup hint states |
| ComposerActionRow.test.tsx | test | Tests ＋-menu actions, browser page/capsule and slash menu |
| ComposerStatusLine.tsx | view | Status line of running/idle meta below the composer |
| composer-draft.ts | util | Persists, restores and prefills drafts |
| composer-draft.test.ts | test | Tests draft keys, parsing and send restoration |
| optimistic-message.ts | vm | Reconciles neutral attachment-bearing local sends with source-aware message evidence |
| useOptimisticUserMessages.ts | hook | Holds the neutral attachment-aware optimistic-send lifecycle for both chats |
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
| useSessionMessageLiveSync.ts | hook | Streams session-scoped messages, compact invalidation and runtime snapshots |
| useSessionMessageLiveSync.test.tsx | test | Tests message authority, compact child suppression and Todo isolation |
| useSessionsLiveSync.test.tsx | test | Tests rail-wide session snapshot refresh |
| useMarkSessionRead.ts | hook | Marks the visible session read |
| SessionIdModal.tsx | view | Shows session identifiers in an accessible bare dialog with success-only shared copy feedback |
| session-id.ts | vm | Builds identifier rows with a dash fallback |
| PaneToggle.tsx | view | Chevron button collapsing either side pane, mirrored per side |
| RightPanel.tsx | view | Animates scoped work tabs or notes and adapts the shared machine roster count |
| right-panel-vm.ts | vm | Formats canonical USD budget plus thread and machine metadata |
| right-panel-vm.test.ts | test | Tests budget, thread and machine view models |
| RightThreadCard.tsx | view | Opens run, task and thread details from activity rows |
| RightThreadCard.test.tsx | test | Tests waiting-task click delegation |
| RightMachinesTab.tsx | view | Adapts the shared machines resource into independently expandable desktop telemetry cards |
| scope.ts | util | Groups active and historical threads |
| scope.test.ts | test | Tests fixed thread lifecycle groups |
| useRecentNow.ts | hook | Ticks recent lists once per minute |
| useRecentNow.test.ts | test | Tests recent-list timer and cleanup |
| useThreadsLiveSync.ts | hook | Refreshes the thread list on thread events |
| useSessionsLiveSync.ts | hook | Refreshes the session list on lifecycle events |
| SelectedSessionProvider.tsx | provider | Shares sessions and external draft prefill |
| selected-session.ts | vm | Resolves selected session and transition profile |
| selected-session.test.ts | test | Tests SessionInfo selection and transitions |

| DebugDetailsModal.tsx | view | Inspector dialog with scoped hover controls |
| debug-inspector.test.tsx | test | Tests hover scope, counting and debug formatting |
