# Mobile 项目记忆 — file viewer + expandable memory dirs (1j)

## Problem

On the mobile 项目记忆 screen (`/m/memory`, scheme 1j):

- The `核心` top-level file rows (mission/roadmap/STATUS/TASKS) are **inert** — tapping does nothing, so you can't read a file on mobile.
- `experiments / knowledge / patterns / decisions` render only a header + an **inert** `查看全部 N 个 ›` row. The individual files are neither listed nor openable.

Root cause is a data gap, not just UI: `memory.tree({projectId})` returns dir **names + counts only** (`MemoryDirEntry = {name, entryCount}`), no per-dir file list. And there is no mobile file-viewer route (the desktop 7b viewer owns per-file browsing today). `memory.file({projectId, path})` already exists and returns raw content — mobile just never calls it.

## Approach

### 1. Backend — enumerate dir entries (additive contract change)

`agent-server/src/domain/ui-service/query/memory.ts` · `handleMemoryTree`: for each memory dir, in addition to `entryCount`, return the real `.md` file list `entries: MemoryFileEntry[]` (`{name, sizeBytes, modifiedAt}`), sorted by name, excluding the auto-generated `index.md` / `CORTEX.md` (same filter as the count). `entryCount` stays `= entries.length`.

`agent-server/src/domain/ui-service/types.ts` · `MemoryDirEntry`: add `entries: MemoryFileEntry[]`. Additive & backward-compatible — the desktop 7b viewer reads only `name`/`entryCount` and is unaffected. Payload is tiny (cortex-self today: 62+20+6+8 ≈ 96 entries × ~60 B).

No input-schema change (`memory.tree` input unchanged); the output type flows to the browser via the existing `@cortex-agent/ui-contract` re-export of the built `types.d.ts`.

### 2. Mobile UI — tappable files + accordion dirs

`web/src/mobile/v3/m-memory-vm.ts`:
- `MMemoryFileRow` gains a `path` (project-root-relative, e.g. `STATUS.md` or `experiments/EXP-001.md`) alongside `name`/`time`.
- `MMemoryDirCard` gains `entries: MMemoryFileRow[]` built from the new DTO field (`path = ${dir}/${name}`).

`web/src/mobile/v3/MMemoryView.tsx`:
- `核心` file rows become tappable → `onOpenFile(path)`; add a chevron `›` affordance and pressed feedback.
- Dir cards become **accordions**: the card header is a tappable toggle (rotating chevron + real `entryCount`); when expanded it renders the real file rows (each tappable → `onOpenFile(path)`); collapsed shows just the header. The inert `查看全部 N 个 ›` row is removed. Expand state is local (`useState<Set<string>>`), pure client toggle over already-loaded data (no per-expand fetch → snappy). Empty dirs render a muted "empty" row.

`web/src/mobile/v3/MMemoryScreen.tsx`: pass `onOpenFile = (path) => navigate('/m/memory/file?path=' + encodeURIComponent(path))`.

### 3. Mobile UI — read-only file viewer (new drill screen)

New `web/src/mobile/v3/MMemoryFileView.tsx` (pure/presentational) + `MMemoryFileScreen.tsx` (container):
- Route `/m/memory/file` reading `?path=` via `useSearchParams`; data = `memory.file({ projectId, path })`.
- `MDrillHeader` back → `/m/memory`; header shows the filename (basename) + a mono `path · rel-time · N KB` metaline.
- Body = white reading surface rendering the raw markdown via the shared `ChatMarkdown` (same renderer the mobile plan-read page 6b uses). Loading / read-error / empty states honestly handled.
- Read-only. Git diff/blame is **intentionally omitted** (the desktop 7b viewer owns that richer view; mobile is a clean read). Flagged as an honest omission, not a fabrication.

`web/src/mobile/mobile-routes.tsx`: add `{ path: '/m/memory/file', element: <MMemoryFileScreen /> }`. No `mobile-tabs.ts` change needed — `startsWith('/m/memory')` already maps the route to the 项目 tab and hides the bottom Tab bar.

### 4. Tests + docs

- Extend `m-memory-vm.test.ts` (entries → rows w/ correct `path`; top-level `path`) and `MMemoryView.test.tsx` (accordion expand reveals rows; tap fires `onOpenFile`).
- New `MMemoryFileView` render test (markdown body, metaline, back) + a small vm test if a pure helper is extracted (basename / size-format / metaline).
- Doc updates: `web/src/mobile/CORTEX.md` (1j row — now enumerates dir files + file viewer), `agent-server/src/domain/ui-service/CORTEX.md` (memory.tree now carries per-dir entries), and a one-line note in `web/src/features/memory/CORTEX.md` (the tree now carries dir entries; desktop still counts-only for now).

### 5. Verify (build chain)

`pnpm --filter @cortex-agent/server build` → `pnpm --filter @cortex-agent/ui-contract build` → web `tsc --noEmit` + `vitest run src/mobile` + `vite build`, all EXIT 0. (The mobile shell OTAs the SPA, so no APK rebuild is needed to ship this.)

## Out of scope

- No writes / editing from mobile (read-only, consistent with today).
- No git diff/blame on the mobile viewer.
- No change to the desktop 7b viewer behavior (it may adopt `entries` later; not now).

## Touched files

- `agent-server/src/domain/ui-service/types.ts`
- `agent-server/src/domain/ui-service/query/memory.ts`
- `web/src/mobile/v3/m-memory-vm.ts`
- `web/src/mobile/v3/MMemoryView.tsx`
- `web/src/mobile/v3/MMemoryScreen.tsx`
- `web/src/mobile/v3/MMemoryFileView.tsx` (new)
- `web/src/mobile/v3/MMemoryFileScreen.tsx` (new)
- `web/src/mobile/mobile-routes.tsx`
- tests: `m-memory-vm.test.ts`, `MMemoryView.test.tsx`, `MMemoryFileView.test.tsx` (new), `m-memory-file-vm.test.ts` (new, if a helper is extracted)
- docs: `web/src/mobile/CORTEX.md`, `agent-server/src/domain/ui-service/CORTEX.md`, `web/src/features/memory/CORTEX.md`
