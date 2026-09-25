Please update me when files in this folder change.

The session/chat core both chromes render, lifted out of `workbench/` (95 files).
It imports no chrome and no page — everything above points down into it, which is what
lets the desktop workbench and `mobile/screens/MChat*` render the same transcript,
composer and interaction cards without either importing the other.

**Move criterion.** A module belongs here when it is shared by mobile or by at least one
other feature. Anything used only by the desktop three-pane page stays in
`features/workbench/`; anything used only by one mobile screen stays in `mobile/screens/`.
Sharing is the reason to move, not size or tidiness.

## Sub-directories

| dir | what goes there |
|---|---|
| `transcript/` | Loading and rendering a message stream: the transcript query, rows, tool calls, subagents, notices, attachments, edit, optimistic and reveal pacing |
| `interaction/` | The blocking cards inside a transcript — decisions, interactions, plan read — and the actions/TTL behind them |
| `composer/` | Composer logic with no chrome: draft state, slash commands, scope, context usage, model label |
| `list/` | Session/project list logic: grouping, menus, rail ordering, ids, run status, stats |
| `live/` | The session's subscriptions to `features/live`: message and list sync, delta stream, waitpoints, compact, read marks |
| `rail/` | The two transcript side rails shared by both chromes: todos and waits |
| `state/` | Which session is selected — `SelectedSessionProvider` and its pure model |

## Entry points

| filename | role | function |
|---|---|---|
| transcript/MessageStream.tsx | entry | The transcript itself — the component both chromes mount |
| transcript/transcript-vm.ts | core | The main view-model: messages → render-ready rows |
| transcript/useTranscriptQuery.ts | core | Every surface's `sessions.transcript` read; refetches as a cursor delta folded in by `transcript-delta.ts` |
| state/SelectedSessionProvider.tsx | entry | The provider mounted by each chrome's shell; `selected-session.ts` holds its pure model |
| composer/composer-draft.ts | core | The draft model every composer chrome writes into |
| live/useSessionMessageLiveSync.ts | core | The subscription that keeps an open transcript current |

## By directory

- **transcript/** (32 files) — `useTranscriptQuery` + `transcript-delta`, `MessageStream`, `ToolCallsRow` + `tool-call-overflow` +
  `useToolCallOverflow`, `SubagentBlock` + `SubagentTranscriptDetail`, `ChatNavRail` +
  `chat-nav`, `ChatNotice`, `MessageEdit`, `MessageAttachmentCards`, `DebugDetailsModal`,
  `optimistic-message` + `useOptimisticUserMessages`, `reveal-pacing` + `useRevealedText`,
  `transcript-vm`, and their colocated `*.test.ts(x)`.
- **interaction/** — `DecisionCards` + `decision-vm`, `InteractionCards` + `interaction-vm`,
  `PlanReadOverlay` + `plan-read-vm`, `useInteractionActions`, `useInteractionTtl`.
- **composer/** — `composer-draft`, `composer-slash`, `scope`, `chat-content`,
  `context-usage` + `ContextUsageControl`, `model-label`.
- **list/** — `session-groups` (incl. `orderSessions`, the order both chromes list sessions in), `session-id`, `session-run-status`, `session-stats`,
  `left-rail-projects`, `selection-menu`, `project-menu`, `profile-menu`, `schedule-rail`,
  `scheduled-chat`.
- **live/** — `useSessionMessageLiveSync`, `useSessionsLiveSync`, `useThreadsLiveSync`,
  `useAssistantDeltaStream`, `useSessionWaitpoints`, `useSessionCompact`,
  `useMarkSessionRead`.
- **rail/** — `TodoRail` + `todo-vm`, `WaitRail` + `wait-rail-vm`, and `rail-surface` (the inline
  and floating composer-rail surface both rails share).
- **state/** — `SelectedSessionProvider`, `selected-session`.

Every `*-vm.ts` here is pure (no React, no tRPC) and carries a colocated vitest file.

Menu/picker chrome these components share with the workbench (`MenuChrome`) and the markdown
renderer (`ChatMarkdown`) live in `design/`, not here: both chromes' non-session menus use them too.
