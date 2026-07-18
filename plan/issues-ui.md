# Issues UI (design scheme.dc.html sec-24) — implementation plan

Branch `feat/issues-ui`, worktree `/home/fangxin/Cortex-wt-issues-ui`. Mirrors the approvals
feature end-to-end (7a modal / 1f mobile / markdown-file-backed paired tRPC scope).

## Semantics (design sec-24)

- Source: per-project `ISSUES.md` (`<contextDir>/ISSUES.md`, agent-written). UI is read-only for
  content — no add, no status field. In the list == pending; leaving the list only via:
  - **处理 (handle)**: create a NEW direct session carrying the issue full text as the first user
    message, then REMOVE the entry from ISSUES.md. Returns `{sessionId}`; UI navigates to it.
  - **删除 (delete)**: remove the entry outright.
  Both are recorded by the automatic `ui.mutate-invoked` audit event (events-YYYYMMDD.jsonl).
- Issues never block threads → no amber, never in the mobile 「需要你」 bar, no LeftRail badge.
- Entry points: desktop Overview header stat (`N issues`, hidden at 0) + Overview Issues card
  (next to Project memory); mobile project (1e) Overview card → `/m/issues` full page.

## Real ISSUES.md format (verified cortex-self + flywheel)

- Optional H1 + preamble + `---` at top — skipped.
- Entry anchor: column-0 `- **<title>** (<paren text>)`; paren text freeform
  (`2026-07-02`, `2026-07-04, 更新 07-10`, `2026-06-12 起，持续更新`) → `date` = first
  `YYYY-MM-DD` found, else null.
- Body: following lines until the next column-0 `- ` bullet / heading / `---` / EOF; raw markdown,
  freeform sub-bullets `- <label>：<text>` with arbitrary labels (问题/发生时机/调查过程/建议/规避/Fix…).
- `id` = sha1(title line).slice(0,8) (mirrors approvals headingId).
- DTO `IssueInfo { id, title, date: string|null, body: string }` — no source/files/status fields
  exist in the markdown → honest omit in UI (no fabricated 来自/相关文件/ttl).

## Backend (agent-server, TDD)

- `domain/ui-service/query/issues.ts` — pure `issueLineId()` + `parseIssues(md): IssueInfo[]` +
  `handleIssuesList(deps, {projectId})` (projectStore.get → contextDir/ISSUES.md; missing file → []).
- `domain/ui-service/mutate/issues.ts` — pure `removeIssueEntry(md, id)` (byte-preserving except the
  removed block; not-found throw) + `buildIssuePrompt(projectId, entry)` +
  `handleIssuesDelete` (read→remove→atomicWriteSync → `{id, deleted:true}`) +
  `handleIssuesHandle` (find entry → `deps.createDirectSession({projectId})` +
  `deps.sendSessionMessage` with the prompt → remove entry → `{sessionId}`).
  No new UiServiceDeps — projectStore/createDirectSession/sendSessionMessage/bus already exist.
- Wiring: `types.ts` (QueryScope `issues.list`, MutateOps `issues.handle`/`issues.delete`, DTO,
  params/args/returns + keyed maps), `input-schemas.ts` (+ keyed maps), `ui-service.ts` handler maps,
  `app-router.ts` `issues` sub-router.
- `packages/ui-contract`: re-export dto/schemas + parity guard entries.
- Tests: `agent-server/tests/ui-service-issues.test.ts` (parser tolerance on real-world shapes,
  id stability, delete removes exactly one block, handle composes prompt + removes + returns sessionId,
  unknown project/id → not-found).

## Desktop web

- `features/issues/issues-vm.ts` (+`.test.ts`) — pure: `parseIssueBody(body)` →
  `{ fields: {label, text}[], desc: string|null }` (generic `- <label>：` bullets; leftovers → desc),
  `issuesCountLabel`, `toIssueListCard`, `toIssueDetail`, `defaultSelectedId`.
- `features/issues/IssueCenterModal.tsx` (+`issue-center-render.test.tsx`) — 24b, isomorphic to
  ApprovalCenterModal: backdrop + 1150×730 shell; header `Issues` + neutral count pill +
  `<project>/ISSUES.md` + esc; left 400px queue (title + date, selected accent border); right detail
  (title, `记录于 <date>` meta, 76px-label grid of parsed body fields); footer note + 删除
  (danger outline, two-step arm 确认删除) + 处理 (accent solid). No status pill, no amber.
- `features/issues/IssuesProvider.tsx` — `useIssues().open(issueId?)`; mounted in `AppShell`.
- `features/overview/OverviewView.tsx` — header stat `N issues` (mono, accent count, hidden at 0,
  click → open modal); Issues card in grid (rows: title + date + ↗, click → open at issue;
  footer `查看全部 N ›`). Plain CARD chrome — the design's accent border+glow on 24a cards is the
  spec's "new element" highlight, not the shipped style (matches sibling Project-memory card).
- Handle success → close modal, `selectCreatedSession(sessionId)` + navigate `/workbench`.
- i18n keys in `i18n/vocab.ts`.

## Mobile web

- `mobile/v3/m-issues-vm.ts` (+test) — `buildMIssuesVm(entries)` reusing `parseIssueBody`.
- `mobile/v3/MIssuesView.tsx` (+`MIssuesView.test.tsx`) — 24c: MDrillHeader (Issues + count pill +
  `ISSUES.md` trailing), expanded first card (date row, title, body fields, 删除 104px danger outline
  + 处理 flex accent, 44px), collapsed cards (title + date), footer hint. No amber.
- `mobile/v3/MIssuesScreen.tsx` — `issues.list({projectId: current})`, expandedId state,
  delete/handle mutations; handle → `navigate('/m/session/<sessionId>')`; back → `/m/project`.
- `mobile-routes.tsx` `/m/issues` + `mobile-tabs.ts` SUBROUTE_TAB → project.
- `MProjectView.tsx` — Issues card (24a right): title + neutral count pill + ›, first 2 titles,
  `+ N more`; hidden at 0; below ApprovalBar. Container `MProjectScreen` supplies the list.

## Decisions

- Handle removes the entry at handle time (design: 处理/删除后即离场) — the new session owns it.
- Removal side effect happens server-side inside `issues.handle` so removal+session are one mutate
  (one audit event).
- No dedicated EventBus event type — `ui.mutate-invoked` already logs both ops with args.

## Gates

web `pnpm typecheck` + `vitest run` (targeted dirs), agent-server targeted vitest files,
`corepack pnpm -r run build`, then merge back to main per worktree discipline (no push).
