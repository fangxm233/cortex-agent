# features/workbench/ — Workbench app-shell frame + Left Rail + Center Chat + Right Panel (Stage-R RB)

The `/workbench` route is the app-shell **frame** — the load-bearing seam every workbench pane
composes into (plan §8.6 RB). Rebuilt 1:1 from `design/ref/prototype.dc.html` L39–100: a single
`display:flex;height:100vh;min-width:1180px;overflow:hidden` row holding three panes — **240px**
LeftRail (flex:none) / **fluid** CenterChat (flex:1;min-width:0) / **400px** RightPanel (flex:none).
LeftRail (f528) + CenterChat (89e7) + RightPanel (1e96) are all real 1:1 — the RB frame is complete.

## Active (RB frame)

| path | role |
|---|---|
| `WorkbenchPage.tsx` | Route `/workbench`. The outer flex frame (prototype L39) assembling `<LeftRail/> <CenterChat/> <RightPanel/>`. |
| `LeftRail.tsx` | **Real Left Rail 1:1** (prototype L42–100). Exact inline styles/px/hex/font/weight/EN copy; real `projects.list` + **project-scoped `sessions.list`** (+ `cost.summary`) substituted into the design's structure. `sessions.list` is scoped by the current project (`projectId: activeProjectId`) so **switching project switches the session list**. cx logo + daemon dot · project card (active project = the shared cross-pane current project via `useCurrentProject`, task 569c; avatar initials; cost-only sub-line) — **clicks open the project switcher popover** (`ProjectMenu`, task c3ce; adds a `threads.list` query for real running counts; Esc/outside-click close; **a switch calls `setCurrentProject(id)`**, task 569c) · + New session (⌘N — REAL `sessions.create` mutation: creates a live origin='direct' session, invalidates `sessions.list` + `setSelectedSession(newId)`) · session rows write the **shared selected-session state** (`useSelectedSession`, `setSelectedSession(id)` on click → the center chat re-points) · session groups TODAY/YESTERDAY/EARLIER · approval banner (hidden, GAP-1) · EN/中 (EN active) · Settings→`/settings`. |
| `ProjectMenu.tsx` | **Project switcher popover 1:1** (prototype L1565–1607, task c3ce). Fixed overlay (click-catcher z-58 / menu z-59) at `left:10;top:106;width:282`. Header = active project + real sub-line (`projMenuSubLabel`) + "Open project overview →" (→`/overview`); SWITCH PROJECT list = real projects minus active with real running counts; **"+ New project" → opens the New-project modal** (task c551, wired via LeftRail `onNewProject`). List `maxHeight:420;overflow:auto` bounds the real 20-project volume (prototype mock had 3) so the footer stays reachable. **Switch now drives the shared cross-pane current-project state** (task 569c): `onSwitch(id)` → `setCurrentProject(id)` (pure front-end selection; no backend switch op). GAP: phase labels ("idle/paused/M3.1") have no backing field → real running count only. |
| `CurrentProjectProvider.tsx` | **Cross-pane current-project state** (task 569c). React context + `useCurrentProject()` (`{currentProjectId, setCurrentProject}`); mounted in `WorkbenchPage` around the three panes. Owns the derivation — queries `projects.list` + `sessions.list({origin:'direct'})` (react-query dedupes with LeftRail's identical queries → no extra network) and holds an explicit user override set by the switcher. Effective `currentProjectId = override ?? derived default`; an explicit switch is sticky. Writer = LeftRail switcher; reader = RightPanel cost bar. Mirrors `approvals/ApprovalsProvider`. |
| `current-project.ts` / `current-project.test.ts` | **Pure** state logic (TDD, 6 tests): `deriveActiveProjectId` (most-recent session's project, else first listed project, else null — extracted verbatim from the former inline LeftRail derivation) · `resolveCurrentProjectId` (override wins, else derived). |
| `NewProjectModal.tsx` | **New-project modal 1:1** (prototype L1407–1429 + backdrop L1291, task c551). 540px white card r14 + scrim; header (title · mono `context/projects/` breadcrumb · esc chip) · PROJECT NAME label · autofocus mono input (1.5px `#C9CFF2` r9) + hint · Cancel + Create (`createBg` accent/muted). Submits the **real `projects.create` tRPC mutation** → on success `invalidateQueries(projects.list)` + close (new project appears in the switcher). Rendered from LeftRail local `newProjOpen` state (mirrors ProjectMenu; no global provider). HONEST ADDITION (flagged): the prototype has no error UI, but the backend can reject (`already-exists`/`invalid-name`) → on error the hint row shows the backend's own message in danger `#C03D33`, reverting on next keystroke. Verified live vs `proto-shots/15-newproj-modal.png` (`design/build-shots/c551-newproj-modal-compare.png`). |
| `new-project.ts` / `new-project.test.ts` | **Pure** (TDD, 5 tests): `canCreate` (non-empty trimmed) · `createBg` (prototype `npCreateBg` accent/muted) · `createErrorMessage` (surfaces the real backend message; neutral fallback) + verbatim EN copy constants (`NP_TITLE`/`NP_BREADCRUMB`/`NP_LABEL`/`NP_PLACEHOLDER`/`NP_HINT`/`NP_CREATE_LABEL`/`NP_CANCEL`). |
| `project-menu.ts` / `project-menu.test.ts` | **Pure** (TDD, 8 tests): `runningCountByProject` (threads.list running+waiting grouped by projectId) · `buildSwitchList` (projects minus active + real counts) · `switchRowMeta` · `projMenuSubLabel` (`N threads running · $X today`). |
| `CenterChat.tsx` | **Real CENTER CHAT 1:1** (prototype L103–395, task 89e7 → **S4 chat aba0**). Same `export function CenterChat()`. Fills the fluid center pane; resolves the **active session from the shared cross-pane selection** (`useSelectedSession`, resolved against the project-scoped `sessions.list`) — clicking a LeftRail row switches the chat. Runs the real `sessions.transcript` query + `useSessionMessageLiveSync`, builds prototype rows via `transcript-vm`, composes `ChatHeader` + `MessageStream` + `Composer`. Passes the session's `profileName` + `hasHistory` to `ChatHeader` for the profile switcher. `running` is snapshot + delta: `SessionInfo.running` (sessions.list) restores the true state on mount/switch/reload; the live `session.status` event overrides once received. |
| `SelectedSessionProvider.tsx` | **Cross-pane selected-session state** (issue: clicking a session didn't switch the chat). Context + `useSelectedSession()` (`{selectedSessionId, setSelectedSession}`), mounted in `WorkbenchPage` inside `CurrentProjectProvider`. Queries the current project's `sessions.list` (dedupes) + holds a click override; effective selection = override-while-in-list else most-recent. Because the list is project-scoped, switching project re-points the chat. Mirrors `CurrentProjectProvider`. |
| `selected-session.ts` / `selected-session.test.ts` | **Pure** (TDD, 6 tests): `deriveMostRecentSessionId` + `resolveSelectedSessionId(override, sessions)` (override wins only while still in the list — so a project switch drops a stale selection). |
| `ChatMarkdown.tsx` | **Chat Markdown renderer** (issue: chat text had no line breaks / markdown). Reuses the pure `features/memory/markdown.ts` `parseBlocks`/`parseInline` with chat-tuned typography (headings/paragraphs/lists/fenced code/inline bold·italic·code·links/table/hr); paragraphs use `white-space:pre-wrap` so single line breaks survive. Used by `MessageStream` for assistant text. |
| `ChatHeader.tsx` | Chat header (prototype L107–130): **real session title** (task aba0) · profile chip · running/idle pill (derived) · ⌘K (dispatches the global palette keydown). The profile chip **opens the profile picker popover** (`ProfileMenu`) bound to the **REAL configured profiles** (`config.get` → `profiles`): the chip shows the session's active `profileName` (falls back to `defaultProfile`); picking a profile calls the **real `sessions.setProfile` mutation** then invalidates `sessions.list`. Cross-backend options are disabled once the session has history (`hasHistory` prop from CenterChat) — the shared switch rule. |
| `ProfileMenu.tsx` | **Profile picker popover 1:1** (prototype L112–120). Absolute-anchored `left:0;top:26` inside the chip's relative span. Renders the real profile options; a `disabled` (cross-backend on a live session) option is greyed, non-clickable, with a tooltip. |
| `profile-menu.ts` / `profile-menu.test.ts` | **Pure** (TDD, 6 tests): `buildProfileOptions(profiles, active, {currentBackend, hasHistory})` (real `ConfigProfileEntry[]` → options w/ model sub-label + `disabled` cross-backend flag) + `currentBackendOf`. Backs the shared same-backend switch rule client-side. |
| `MessageStream.tsx` | Message stream (prototype L131–357), **rows-driven** (task aba0): renders the `ChatRow[]` built from REAL `sessions.transcript` + live tail — TODAY divider · right-aligned user bubble (`white-space:pre-wrap` for line breaks) · `ToolCallsRow` · assistant text **rendered as Markdown** via `ChatMarkdown` (streaming `cxblink` caret on the last row while live). **Sticks to the bottom** while new content lands, releasing when the user scrolls up and re-pinning at the bottom (scroll-container ref + `stickRef`). The former always-on representative surfaces (`InlineThreadCardProto` + `ApprovalCard` APR-0007) were **removed** — they were fixed placeholders always shown in every chat. Empty session → the prototype `chatEmpty` empty-state (L133–143, verbatim EN copy). Kept 1:1 surfaces: `InlineThreadCardProto` (LIVE `threads.get`) + `ApprovalCard` (Stage-5 GAP-B, representative). |
| `ToolCallsRow.tsx` | Collapsed/expanded tool-call row (prototype L152–172); local toggle. Fed real tool events (`toolName`/`toolInput`) mapped from the transcript. |
| `ApprovalCard.tsx` | Inline approval-required card (prototype L247–276, pending·unarmed); INERT Approve/Deny (Stage-5 GAP-B, `REPRESENTATIVE_APPROVAL`). |
| `Composer.tsx` | Composer (prototype L359–395): slash palette (18-slash-menu) · running/idle status line (real `turns`; running-line **elapsed = REAL** session elapsed from `sessions.transcript.elapsedMs`; cost = `—`) · input · `/ commands` chip · **REAL send** (task aba0): ⏎/click → `sessions.send` mutate. **REAL slash exec** (task 970d): running a slash-menu item routes its `/cmd` through the same `sessions.send` mutate (the agent interprets the slash command) via the pure `slashItemDispatch` helper — ⏎/run semantics real, 1:1 visual, no new backend op. **REAL Stop** (task bdc2): click → `sessions.cancel` mutate cancels the agent(s) running on the session's channel; running collapses to idle as the live stream quiets. |
| `composer-slash.ts` / `composer-slash.test.ts` | **Pure** (TDD, 5 tests, task 970d): `slashItemDispatch(cmd)` → the trimmed `/cmd` message a slash-menu run dispatches through `sessions.send` (null for blank/non-slash). Test loops `SLASH_COMMANDS` to prove 1:1 menu→dispatch. |
| `transcript-vm.ts` / `transcript-vm.test.ts` | **Pure** (TDD, 21 tests): `buildTranscriptRows(transcript, liveTail, {streaming})` → prototype `ChatRow[]` (divider on day-change · user · collapsed tools · assistant + streaming caret); `liveToMessage` (session.message→TranscriptMessage; live `elapsedMs`=null, reconciles on refetch); `turnCount`; `sessionElapsedMs` (sums the DTO's per-message `elapsedMs`) + `formatElapsed` (ms→`Xs`/`Xm Ys`/`Xh Ym`; null→`—`); `resolveRunning(statusRunning, snapshotRunning, streaming)` — the snapshot+delta running precedence (event > sessions.list snapshot > stream heuristic). De-dups the live tail against the fetched transcript. |
| `useSessionMessageLiveSync.ts` | Thin React/SSE glue (task aba0): one `subscribe({events:['session.message','session.status'], sessionId})` → bounded live-tail buffer (streams assistant/tool output) + invalidates `sessions.transcript` for reconciliation. Returns `running` via the pure `resolveRunning` (**snapshot + delta** fix — running was lost on session switch / reload / SSE reconnect): the live `session.status` event (delta) wins once received; before that the caller-passed `SessionInfo.running` snapshot governs; the message-stream idle heuristic (`streaming`) is the last resort (old servers). Invalidates `sessions.list` on BOTH status edges (rail dots) and refetches list+transcript on SSE **reconnect** (`onConnectionStateChange` → re-entered `pending`). Mirrors `useThreadGetLiveSync`. |
| `useSessionsLiveSync.ts` | Rail-wide running live-sync: one UNSCOPED `subscribe({events:['session.status']})` → invalidate `sessions.list`, so every LeftRail row's running dot refetches on any session's turn start/end (the chat's subscription covers only the selected session). Mirrors `useThreadsLiveSync`. |
| `InlineThreadCardProto.tsx` | **LIVE inline thread card** (prototype L180–246) bound to REAL `threads.get` (B1): picks the first running/waiting thread from `threads.list`, maps `ThreadDetail`→prototype rows via `thread-card-proto`, re-flows live via `useThreadGetLiveSync`. The one live-data surface of the chat. |
| `thread-card-proto.ts` | **Pure** (TDD): `threadPill` (status→prototype pill pair) + `buildThreadCard` (`ThreadDetail`→vertical rows; only the running step expands its subthread cards + nested rows; done/pending collapse). |
| `thread-card-proto.test.ts` | vitest for `thread-card-proto.ts` (4 tests). |
| `chat-content.ts` | Static non-data content (task aba0 trimmed the transcript constants — the body is now real): `toolCallsLabel` + `ToolCall`/`ApprovalContent` types · `SLASH_COMMANDS` (18-slash-menu, verbatim) · `REPRESENTATIVE_APPROVAL` (Stage-5 GAP-B) · `DEFAULT_CHAT_PROFILE`. |
| `chat-content.test.ts` | vitest for `chat-content.ts` (4 tests). |
| `RightPanel.tsx` | **Real Right Panel 1:1** (prototype L1091–1276, task 1e96). Same export `RightPanel(): JSX.Element` (replaced the f528 STUB). Exact inline styles/px/hex/font/weight/EN copy; real tRPC data. **Threads + Tasks are scoped to the shared cross-pane current project** (`projectId` on `threads.list`/`tasks.list`, incl. counts and `TasksPanel`) so the panel shows only this project's work; Machines stay cross-project. Tab bar Threads/Tasks/Machines + counts · cost/budget bar (real `cost.summary.today` scoped via `useCurrentProject`, task 569c; budget denominator GAP-B) · Active/History toggle (`scope.ts`) · Threads tab = `RightThreadCard` list · Tasks tab = reused `features/tasks/TasksPanel` (now takes `projectId`) · Machines tab = `RightMachinesTab`. |
| `RightThreadCard.tsx` | One thread card 1:1 (prototype L1115–1185). Header (node icon · mono templateName · status pill · meta line · depth dots) + collapsible step-tree body (running/opened cards fetch `threads.get`; dot+tail grid, active-step dispatch/subthread sub-cards) + footer (Pause · Cancel · Detail · Σcost). Cancel = real `threads.cancel` mutation → invalidates `threads.list`/`threads.get` (live). Pause inert (GAP-P). |
| `RightMachinesTab.tsx` | Machines tab **real 1:1** (prototype L1237–1274, task 2a13). Queries `machines.list`; renders machine cards (name / Online-Offline pill / GPU ×N / live-runs pulse dot) + empty / loading / error states. Replaces the GAP-M structural stub. |
| `right-panel-vm.ts` | **Pure** VM helpers (TDD): `threadPill` (verbatim prototype `pill()` hexes) · `stepDotKind` · `formatCost`/`formatDurationS`/`stepMeta` · `formatAge`/`threadMetaLine` · `depthInfo` (reuses `thread/nested-threads` `treeMaxLevel`) · `actionableCount` · `machinePill` (task 2a13). |
| `right-panel-vm.test.ts` | vitest for `right-panel-vm.ts` (21 tests, +2 `machinePill` tests, task 2a13). |
| `session-groups.ts` | **Pure** helpers (TDD): `groupSessions` (local-day TODAY/YESTERDAY/EARLIER partition, recent-first), `sessionMeta` (HH:MM + `· from schedule`), `projectInitials`. |
| `session-groups.test.ts` | vitest for `session-groups.ts` (10 tests). |
| `scope.ts` / `scope.test.ts` | Active/History → query-filter mapping (`threadScopeFilter` status[] · `taskScopeFilter` open\|done). Reused by RightPanel. |
| `useThreadsLiveSync.ts` | One SSE subscription on thread lifecycle events → invalidate `threads.list` (Threads tab live-sync). |

**Data gaps rendered structurally + flagged** (paired stage). Left Rail (f528): GAP-1 approvals
banner — no tRPC approvals scope → conditionally hidden (**Stage 5**); GAP-2 **running RESOLVED**
(2026-07-14 snapshot+delta fix) — `SessionInfo.running` (live snapshot from `runningExecutions`)
drives the prototype pulse dot, kept fresh by `useSessionsLiveSync`; turns/cost still absent
(session-detail backend, later); GAP-3 `ProjectConduitInfo` no
phase/milestone → project sub-line cost-only (**Stage 6**). Center Chat (89e7 → **S4 aba0**):
**GAP-A RESOLVED** — the transcript body is now REAL (`sessions.transcript` query → prototype rows,
grouped turns/tools/assistant); **GAP-C RESOLVED** — composer send is REAL (`sessions.send` mutate) and
assistant output streams back live via the `session.message` subscription (`useSessionMessageLiveSync`).
Remaining Center-Chat gaps: GAP-B approval card — no approvals scope → representative APR-0007, inert
(**Stage 5**); session **elapsed** — now REAL: `sessions.transcript` carries per-message `elapsedMs`
(ts-derived), summed to the running-line elapsed readout. Session **cost** stays `—`: **no real
attribution source** — conversation-history carries no cost; `costs.jsonl`/`CostEntry` is keyed by
project/trigger with no session/turn/message linkage (escalated to manager, task 30da). composer **Stop** — RESOLVED
(task bdc2): the `sessions.cancel` MutateOp resolves session→channel and cancels the live agent(s) on that channel
(reuses the `!cancel` channel-cancel path via an injected `cancelSessionRun` dep); **slash execution** — RESOLVED
(task 970d): running a slash-menu item dispatches its `/cmd` as a real slash command through the existing
`sessions.send` mutate (the agent interprets it) — pure `slashItemDispatch` helper, 1:1 visual, no new backend op.
The other LIVE center surface (inline thread card,
`threads.get`) is kept. Right Panel
(1e96): **GAP-M RESOLVED** (task 2a13) — Machines tab now real (`machines.list`, machine cards rendered); **GAP-P** Pause — no `threads` pause MutateOp (inert affordance); **GAP-B**
budget denominator — `CostSummary` has `today` only, no budget scope (rendered `today` real, `/ —` +
empty bar; **Stage 7**).

## Legacy (superseded — KEPT, not route-reachable)

`InlineThreadCardProto` · `ApprovalCard` (+ `chat-content.REPRESENTATIVE_APPROVAL`) — the fixed
representative surfaces the chat used to always show; **no longer rendered** by `MessageStream`, kept
as files for any future reuse. `SessionList` · `ChatPlaceholder` (token-summary 3a, task 5b0f). The old right-panel
`RightPanelTabs`/`ThreadsPanel`/`MachinesPanel` were **removed** by 1e96 (replaced 1:1).
`features/thread/InlineThreadCard` (the design/*-primitive Stage-3 card) is now unreferenced — the
Center Chat uses its own 1:1 `InlineThreadCardProto`; kept valid for any future reuse.

## Notes

- **Web-only** — the S4 chat backend (`sessions.transcript` query, `sessions.send` mutate,
  `session.message` subscribe event) is delivered by a paired be leaf; this task consumes it and
  changes only `web/`. Other consumed scopes: `projects.list`, `sessions.list`, `cost.summary`,
  `threads.list`/`threads.get`/`threads.cancel`/`subscribe` (center inline card + right panel).
- **Verified live** (task f528): real dist ui-http-server + real `ProjectStore`/`sessionStore`/
  `getCostSummary` (real ~/.cortex data) serving built `web/dist` behind `x-cortex-token`;
  headless-Chrome CDP (token via `Network.setExtraHTTPHeaders`) at 1440×900 → frame **240/800/400**,
  **759 real sessions** grouped, real project card, stubs mounted, **0 console errors**. Side-by-side
  vs `proto-shots/00-workbench.png` committed at `design/build-shots/f528-leftrail-compare.png`.
- **Verified live** (task 89e7, Center Chat): same real dist ui-http harness + real `threadStore`/
  `executionRegistry` (122 real threads) + headless-Chrome CDP at 1440×900 → center pane renders the
  chat surface 1:1 (header/divider/user/tool-calls/assistant+chips/approval/composer all asserted);
  the inline thread card bound to **REAL `threads.get`** (live thread `thr_716d87f1` coder-review),
  **0 console errors**. Side-by-side vs `proto-shots/00-workbench.png` (center region) committed at
  `design/build-shots/89e7-centerchat-compare.png`. Real-data differences vs the mock (flagged): the
  live thread card shows the actual thread's steps (no persisted subthreads locally; B1 `x/N`
  off-by-one → `Step 2/1`); status-line clock is the static default `42:13` (prototype's live tick
  reads `42:14`).
- **Right panel verified live** (task 1e96): same real dist ui-http harness with real `threadStore`
  (122)/`taskStore`/`executionRegistry`/`getCostSummary`; headless-Chrome CDP at 1440×900 → frame
  **240/800/400**, tab bar **Threads 5 / Tasks 20 / Machines 0**, cost bar (real `cost.summary.today`),
  Active/History toggle, real thread cards with `threads.get` step-tree + Pause/Cancel/Detail + Σcost,
  History + Tasks tab switches, **0 console errors**. Side-by-side committed at
  `design/build-shots/1e96-rightpanel-compare.png`. `threads.cancel` live Active→History proven in an
  isolated `CORTEX_HOME` harness over the browser's `httpBatchLink` transport (synthetic thread; zero
  production impact).
