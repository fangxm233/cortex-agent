# features/schedule/ — New-schedule overlay (design 7c)

The「New schedule」overlay, rebuilt **1:1** from `design/ref/prototype.dc.html` L1431–1459 (+ shared
backdrop L1291–1292), diffed vs `design/proto-shots/13-schedule-modal.png`. Wired to the **real**
`schedules.add` tRPC mutation (backend leaf already landed — `MutateOp 'schedules.add'`, zod
`scheduleAddInput`, returns `ScheduleInfo`). Web-only.

| path | role |
|---|---|
| `schedule-modal-vm.ts` | **Pure** (TDD): `ScheduleForm` model + `defaultScheduleForm`; `visibleFields(type)` (TYPE→which cell shows); `buildScheduleAddArgs(form)→ScheduleAddArgs` (unit→raw ms for interval/once, `time`/`dayOfWeek` per type, target mapping); `validateScheduleForm`; `computeNextRun`/`nextRunLabel`/`nextRunParts` (footer); static option lists (`SCHED_TYPES`/`DAY_OPTIONS`/`INTERVAL_UNITS`/`FALLBACK_OPTIONS`/`TARGET_OPTIONS`); `profileOptions(names, current)` — derives the PROFILE `<select>` options from the real profile names (guarantees `current` stays selectable; honest empty when no source). |
| `schedule-modal-vm.test.ts` | vitest for the VM (35 tests, TDD — written first; incl. `profileOptions`). |
| `ScheduleModal.tsx` | **Presentational** 1:1 modal (exact inline styles/px/hex/font/weight/EN copy from the source). Backdrop + 560px card + header/esc + TYPE segmented control (selected `#4655D4`/`#EEF0FA`) + TIME/EVERY/IN cell (TYPE-driven) + DAY cell (weekly) + PROFILE (options from the `profileOptions` prop) + MESSAGE textarea + TARGET/FALLBACK + footer next-run + Cancel + Create schedule. Escape/backdrop/esc-chip close. `data-schedule-modal` / `data-action="create-schedule"` / `data-sched-type` for E2E. |
| `ScheduleModalProvider.tsx` | Global mount + `useScheduleModal()` (`open({projectId?})`/`close()`). Owns the form state + the real `schedules.add` `useMutation` (onSuccess → invalidate `schedules.list` + toast + close; onError → toast); reads `config.get` for the real profile names and feeds `profileOptions` into the modal. One modal instance; mounted in `shell/AppShell` (mirrors the ⌘K / execution-log-drawer mounts). |

## Real data vs data-gap placeholders

- **REAL**: Create schedule → `schedules.add` (type/message/projectId/profile + per-type
  `intervalMs`/`time`/`dayOfWeek`/`delay` + `target`/`fallback`), returns a `ScheduleInfo`; the
  Overview Schedules list is invalidated → the new schedule appears live.
- **Trigger**: the Overview Schedules-card `+ New` (`features/overview`) calls
  `useScheduleModal().open({projectId: activeProjectId})`.

## Flagged gaps / adaptations (no fabricated values)

- **PROFILE** — **real**: the dropdown lists the actual agent profiles from `config.get`
  (`ConfigSnapshot.profiles.profiles[].name`, read redacted from `~/.cortex/config/profiles.json`),
  derived by `profileOptions(names, form.profile)`. Sent as the optional `ScheduleAddArgs.profile`.
  Honest degrade: when profiles.json is absent (`config.get` returns `profiles: null`) the list holds
  only the form's current value — never a fabricated set.
- **TARGET** — `ScheduleTarget` is `fresh | project{projectId} | thread{threadId,channel}`. The web
  has no channel/threadId source, so only constructible choices are offered:
  `current-channel`→**omit `target`** (scheduler default; prototype default label kept 1:1),
  `fresh`→`{kind:'fresh'}`, `project`→`{kind:'project',projectId}`. Explicit thread/channel deferred.
- **TYPE→field interactivity** is the one behavior the prototype mock lacks. The prototype only ships
  the **daily** state (proto-shot 13) — that is the visual-diff bar; interval/weekly/once reuse the
  **identical cell chrome**, swapping the visible field (EVERY / TIME+DAY / IN). Weekly widens the top
  grid `130px 130px 1fr` (daily/interval/once stay `130px 1fr`, 1:1).

## Notes

- **No backend change** — `schedules.add` was delivered by a prior backend leaf. Web-only task.
- The prototype modal is a static mock (all bindings are stubs); this rebuild makes it interactive +
  wires a real submit. Structure is authoritative; the variable is real form state + the real mutation.
