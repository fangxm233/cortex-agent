# features/connection/ — live UI↔server connectivity

The single source of truth for "is the UI actually talking to the agent-server", surfaced as the
LeftRail **daemon badge** (green connected / amber (re)connecting / red disconnected) — replacing the
former always-green hard-code. Derived from the tRPC subscription link's connection state
(`onConnectionStateChange`), which flips as the SSE stream goes up and down.

| path | role |
|---|---|
| `connection-status.ts` | **Pure** VM (TDD): `deriveConnectionStatus(state, hasConnected)` maps the raw tRPC `idle` \| `connecting` \| `pending` state + a has-ever-connected latch → the display status `connecting` \| `connected` \| `reconnecting` \| `disconnected` (the latch distinguishes the first approach from a post-drop retry, and keeps `idle`-before-connect off the scary "disconnected" on first paint); `connectionDot(status)` → `{color, pulse}` presentational tokens (theme CSS vars, amber pulses while (re)connecting); `connectionLabelKey(status)` → the vocab key (`connConnected`/`connConnecting`/`connReconnecting`/`connDisconnected`, resolved by the caller against the active language). |
| `connection-status.test.ts` | vitest for the pure VM (10 tests). |
| `ConnectionStatusProvider.tsx` | Global provider + `useConnectionStatus()` hook. Opens ONE always-on SSE subscription with an **empty event set** (`events: []`) whose only job is to observe `onConnectionStateChange` — the transport keeps it alive with pings and reports connect/drop/reconnect; feature subscriptions (sessions/threads/chat) handle their own reconnect recovery, this one only surfaces connectivity. Latches `hasConnected` on the first `pending`; a terminal `onError` is treated as a dropped link (`idle`). Mounted once per shell — `shell/AppShell` (desktop, alongside Approvals/Issues/Notifications) and `mobile/MobileShell` (mobile) — so both surfaces can read the live status via `useConnectionStatus()`. |

## Notes

- `pending` is reached from the transport's `connected` handshake (EventSource `open`), independent of
  any data events — so the empty-event subscription still connects.
- Consumers: `features/workbench/LeftRail` header badge (desktop); mobile `MProjectView` header badge
  (1e 项目, right of the title) + `MDaemonView` header pill (1r Daemon) — both via the mobile
  `mobile/v3/m-connection` tone/pulse mapping (pure, tested). `useConnectionStatus()` defaults to
  `connecting` before the provider's first state change (accurate — the link has not connected yet).
- Verified live: the `events: []` subscription against the real ui-http-server immediately returns
  `event: connected` and holds the stream open → the link reaches `pending` → badge = connected.
