# features/notifications/ — DM-message notification toasts (design 18a)

Surfaces the messages Cortex posts to a user's **direct** chat sessions (origin='direct') as
floating notification toasts, styled 1:1 to `scheme.dc.html` section 18a (系统通知 toast). Driven by
the existing `session.message` SSE stream — **no agent-server change**. Global, mounted in `AppShell`
(desktop shell only; mobile 18a uses system push per the design, out of scope here).

| path | role |
|---|---|
| `notification-vm.ts` | Pure view-model: `NotificationItem`/`NotificationLevel`, `previewText` (whitespace-collapse + clip to `PREVIEW_MAX`), `buildNotification` (session-message → info toast; title = conversation name, meta = preview; **no severity guessing** — level defaults to info), `isTransient`/`AUTO_DISMISS_MS` (info 6s auto; warning/error resident). Unit-tested. |
| `notification-store.ts` | Pure queue reducer: `addNotification` (append newest-last, drop consecutive same-session/same-text dup, `RETAIN_CAP`), `removeNotification`, `splitVisible` (newest `MAX_VISIBLE`=3 + `+N` overflow). Framework-agnostic, unit-tested. |
| `NotificationToaster.tsx` | Presentational 1:1 scheme-18a stack: 380px 白底泡泡 (rounded-11, `proto-line` border, `shadow-toast`, no left color bar), 24px tinted icon square per level, mono meta ellipsis line, `relativeAge` time slot, 2px auto-dismiss progress line (info only, `animate-toastbar` + `onAnimationEnd`→dismiss, `group-hover` pauses both), bottom-right stack + `+N` expand pill. Token-only (zero hex, grep-gated). `relativeAge` unit-tested. |
| `useDmNotifications.ts` | Thin SSE glue: one global `session.message` subscription (no sessionId scope); filters to non-empty `assistant` messages and hands each to `onMessage`. Mirrors `workbench/useThreadsLiveSync`. |
| `NotificationProvider.tsx` | Wiring: gates raw events to DIRECT sessions (via `sessions.list {origin:'direct'}` membership), suppresses the session currently open in the workbench chat, builds + queues the toast, and renders `NotificationToaster`. Click-through re-points project+session and navigates to `/workbench`. Latest-value refs keep the SSE callback stable (no resubscribe churn). |

## Notes

- Distinct from `design/Toast.tsx` (the generic Radix-Toast primitive, which uses a left color-bar) —
  scheme 18a specifies **no** left bar and an icon-square that carries the level color, so this is a
  dedicated build, not a reuse of that primitive.
- `tailwind.config.ts` gains `boxShadow.toast` / `boxShadow.toast-pill` and the `toastbar` progress
  keyframe/animation (6s dwell = `AUTO_DISMISS_MS`).
- DM chat replies emit `info`. The component renders all three levels (`info`/`warning`/`error`); the
  warning/error paths are ready for future server-classified notification events (approval requested /
  execution failed — the scheme 18a examples), which would need a new backend event kind.
- Membership gate means: a thread/scheduled agent session never toasts; only the user's direct DMs do.
  Edge: the very first reply of a brand-new direct session may be missed until `sessions.list` refetches.
