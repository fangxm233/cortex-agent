# features/issues/ — Issues modal (design sec-24, 24a/24b)

The project **Issues** surface — a centered 1150×730 modal (24b) isomorphic to the approval
center 7a, over the real paired `issues.*` ui-service scope: `issues.list({projectId})` for the
queue, `issues.delete` (remove the entry from the project's ISSUES.md) and `issues.handle`
(create a NEW direct session carrying the issue full text as its first user turn, then remove
the entry; returns `{sessionId}` — the container jumps into it via `selectCreatedSession` +
`/workbench`). Differences from approvals BY DESIGN (sec-24): no amber anywhere (issues never
block a thread), no status pill / status column (在列表即待处理 — being listed == pending), content
is read-only (no add from the UI), and leaving the list happens only via 处理 / 删除.

| path | role |
|---|---|
| `issues-vm.ts` | **Pure** VM (TDD): `parseIssueBody` (freeform `- <label>：<text>` sub-bullets → verbatim-labelled fields + unlabelled desc, continuation lines joined), `toIssueListCard` / `toIssueDetail`, `defaultSelectedId`. Framework-free. |
| `issues-vm.test.ts` | vitest unit tests (written first, 11 tests). |
| `IssueCenterModal.tsx` | The 24b overlay. `IssueCenterView` (exported pure presentational — backdrop + shell + header [Issues + neutral count pill + `<project>/ISSUES.md` + esc] + left 400px queue [ISSUES · N cards, title+date, no-status footer note] + right read-only detail [title, `记录于 <date>`, 76px-label grid with VERBATIM markdown labels] + footer [note + 删除 danger-outline two-step confirm + 处理 accent-solid]) and the `IssueCenterModal` container (binds `issues.list` scoped to `useCurrentProject`, selection/armed state, delete/handle mutations with invalidate + toast, handle-success → `selectCreatedSession` + navigate `/workbench`, Escape-close). `data-issue-center` / `data-issue-id` / `data-action="arm-delete\|cancel-delete\|confirm-delete\|handle"` for E2E. |
| `issue-center-render.test.tsx` | `react-dom/server` structural checks of `IssueCenterView` (header/queue/no-amber/no-pill/verbatim-labels/desc/footers/empty — 9 tests). |
| `IssuesProvider.tsx` | Global mount + `useIssues()` context (`open(issueId?)`/`close()`; an id pre-selects that queue entry). Single modal instance mounted in `shell/AppShell` (inside CurrentProject/SelectedSession providers — the container consumes both). |

## Triggers (24a)

- `features/overview/OverviewView` header — the `N issues` stat (mono, accent count; **hidden at 0**)
  opens the modal; the Overview **Issues card** (next to Project memory, hidden at 0) lists up to 3
  entries (row → modal located at that entry) + `查看全部 N ›`.
- Deliberately NOT in the LeftRail / 需要你 surfaces: issues don't block (design sec-24), so they
  never compete with running/approval attention.

## Data gaps (real IssueInfo vs the design mock) — honest, never fabricated

`IssueInfo` = `{id, title, date, body}` parsed from the per-project ISSUES.md (see backend
`query/issues.ts`). The design mock's source slot (`nightly-eval › report · thr_4a1b`), 相关文件
chips, and time-of-day have NO markdown source → omitted (date only, no fabricated clock). Field
labels render verbatim from the real sub-bullets (问题/发生时机/调查过程/建议/规避/Fix…), not the
mock's fixed 描述/证据/相关文件 schema. No `ttl`, no status taxonomy.

## Notes

- Refresh is invalidate-after-mutate (no issues bus event) — approvals precedent.
- Mobile 24c (`mobile/v3/MIssues*`) reuses `parseIssueBody` from `issues-vm.ts`.
