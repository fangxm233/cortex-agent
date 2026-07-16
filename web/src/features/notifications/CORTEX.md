# features/notifications/ — DM-message notification toasts (design 18a)

Surfaces the messages Cortex posts to a user's **direct** chat sessions (origin='direct') as
floating notification toasts, styled 1:1 to `scheme.dc.html` section 18a (系统通知 toast). Driven by
the existing `session.message` + `session.status` SSE streams — **no agent-server change**. DM toasts
are **turn-scoped**: the turn's latest assistant message is buffered and a single toast fires at turn
end (`session.status` running:false), so a multi-message turn no longer produces a burst of toasts.
Also carries server-classified `system.notice` broadcasts (see below). Global, mounted in `AppShell`
(desktop shell only). The **mobile shell** (design 1q) surfaces the same streams as **native OS/system
notifications** via `os-notify.ts` (the Tauri notification plugin) rather than this in-app banner — see
`mobile/v3/MNotificationProvider`, which delivers through `os-notify` and only falls back to the in-app
toaster when the OS path cannot deliver (plain browser / permission denied). The pure vm/store/turn-buffer
here are shared by both shells.

| path | role |
|---|---|
| `notification-vm.ts` | Pure view-model: `NotificationItem`/`NotificationLevel`, `previewText` (whitespace-collapse + clip to `PREVIEW_MAX`), `buildNotification` (session-message → info toast; title = conversation name, meta = preview; **no severity guessing** — level defaults to info), `buildSystemNotice` (`system.notice` event → toast at the server-classified level; title = notice title or generic "System notice"; `sessionId=''`/`projectId=null` since it is not tied to a conversation), `isTransient`/`AUTO_DISMISS_MS` (info 6s auto; warning/error resident). Unit-tested. |
| `notification-store.ts` | Pure queue reducer: `addNotification` (append newest-last, drop consecutive same-session/same-text dup, `RETAIN_CAP`), `removeNotification`, `splitVisible` (newest `MAX_VISIBLE`=3 + `+N` overflow). Framework-agnostic, unit-tested. |
| `NotificationToaster.tsx` | Presentational 1:1 scheme-18a stack: 380px 白底泡泡 (rounded-11, `proto-line` border, `shadow-toast`, no left color bar), 24px tinted icon square per level, mono meta ellipsis line, `relativeAge` time slot, 2px auto-dismiss progress line (info only, `animate-toastbar` + `onAnimationEnd`→dismiss, `group-hover` pauses both), bottom-right stack + `+N` expand pill. Token-only (zero hex, grep-gated). `relativeAge` unit-tested. |
| `useDmNotifications.ts` | Thin SSE glue: one global `session.message` + `session.status` subscription (no sessionId scope); non-empty `assistant` messages → `onMessage` (buffered), `session.status` running:false → `onTurnEnd` (turn boundary → one toast). Turn-scoped so a multi-message turn produces a single toast, not a burst. Mirrors `workbench/useThreadsLiveSync`. |
| `turn-buffer.ts` | Pure per-session "latest assistant message" buffer (`recordTurnMessage` newest-wins / `takeTurnMessage` flush+clear). Delegated from the provider so one toast fires at turn end previewing the final message. Framework-agnostic, unit-tested. |
| `useSystemNotices.ts` | Thin SSE glue: one global `system.notice` subscription; filters to non-empty events and hands each (`level`/`text`/`title`/`ts`) to `onNotice`. No membership gate — every system broadcast surfaces. Mirrors `useDmNotifications`. |
| `os-notify.ts` | **OS/system-notification bridge** (design 1q, mobile). Pure `osNotificationSpec` (NotificationItem → `{title, body}`) + `osNotifyAvailable` (native Tauri shell only, via `isNativeShell()`) + `ensureOsNotifyPermission` (prompts once, cached) + `sendOsNotification(spec, data?)` (dynamic-imports `@tauri-apps/plugin-notification`; carries an opaque `data` map in the notification `extra` for tap-routing; returns false when it cannot deliver so the caller falls back to the in-app toaster) + `onOsNotificationAction(cb)` (subscribes to notification taps via the plugin `onAction`, handing the `extra` back so the caller can deep-link; no-op off-shell). Route-agnostic — it only carries the payload; the provider interprets it. No-op in a plain browser — the Android System WebView has no web Notifications API, so the native plugin is the only OS path. Unit-tested (plugin + shell mocked). |
| `NotificationProvider.tsx` | Wiring: (1) DM path — buffers each session's latest assistant message (`turn-buffer`) and emits ONE toast at turn end (`onTurnEnd`), gated to DIRECT sessions (via `sessions.list {origin:'direct'}` membership) and suppressing the session currently open in the workbench chat; (2) system path — queues every `system.notice` (`useSystemNotices` → `buildSystemNotice`) with no gate. Builds + queues into one shared stack, renders `NotificationToaster`. Click-through re-points project+session and navigates to `/workbench` for DM toasts; a session-less system toast only dismisses. Latest-value refs keep the SSE callback stable (no resubscribe churn). |

## Notes

- Distinct from `design/Toast.tsx` (the generic Radix-Toast primitive, which uses a left color-bar) —
  scheme 18a specifies **no** left bar and an icon-square that carries the level color, so this is a
  dedicated build, not a reuse of that primitive.
- `tailwind.config.ts` gains `boxShadow.toast` / `boxShadow.toast-pill` and the `toastbar` progress
  keyframe/animation (6s dwell = `AUTO_DISMISS_MS`).
- DM chat replies emit `info`. System notices carry a server-classified level: startup/restart and
  hot-reload emit `info`; disk / rate-limit / codex-usage emit `warning`. The component renders all
  three levels (`info` auto-dismisses; `warning`/`error` stay resident). The backend event kind is
  `system.notice`, published through the encapsulated `emitSystemNotice` seam (agent-server
  `domain/system/system-notice.ts`).
- Membership gate applies to DM toasts only: a thread/scheduled agent session never toasts; only the
  user's direct DMs do. System notices bypass the gate entirely. Edge: the very first reply of a
  brand-new direct session may be missed until `sessions.list` refetches.
