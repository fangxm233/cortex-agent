# features/connection/ — live UI↔server connectivity

The single source of truth for "is the UI actually talking to the agent-server", surfaced as the
LeftRail **daemon badge** (green connected / amber (re)connecting / red disconnected) — replacing the
former always-green hard-code. Derived from the tRPC subscription link's connection state
(`onConnectionStateChange`), which flips as the SSE stream goes up and down.

| path | role |
|---|---|
| `connection-status.ts` | **Pure** VM (TDD): `deriveConnectionStatus(state, hasConnected)` maps the raw tRPC `idle` \| `connecting` \| `pending` state + a has-ever-connected latch → the display status `connecting` \| `connected` \| `reconnecting` \| `disconnected` (the latch distinguishes the first approach from a post-drop retry, and keeps `idle`-before-connect off the scary "disconnected" on first paint); `connectionDot(status)` → `{color, pulse}` presentational tokens (theme CSS vars, amber pulses while (re)connecting); `connectionLabelKey(status)` → the vocab key (`connConnected`/`connConnecting`/`connReconnecting`/`connDisconnected`, resolved by the caller against the active language). |
| `connection-status.test.ts` | vitest for the pure VM (10 tests). |
| `ConnectionStatusProvider.tsx` | Global provider + `useConnectionStatus()` hook. Opens **nothing**: it derives the badge from the app's single shared live stream (`features/live/LiveEventsProvider` → `useLiveConnection()`), whose `connState` + `hasConnected` latch feed the unchanged pure `deriveConnectionStatus`. It used to open its OWN subscription with an **empty event set** purely to observe `onConnectionStateChange` — a whole HTTP connection spent on a heartbeat, which mattered because the app then held six SSE connections and starved every other request on a plain HTTP/1.1 origin (see `features/live/CORTEX.md`). Mounted once per shell — `shell/AppShell` (desktop) and `mobile/MobileShell` (mobile) — INSIDE `LiveEventsProvider`. |

## Notes

- `pending` is reached from the transport's `connected` handshake (EventSource `open`), independent of
  any data events — so the empty-event subscription still connects.
- Consumers: `features/workbench/LeftRail` header badge (desktop); mobile `MProjectView` header badge
  (1e 项目, right of the title) + `MDaemonView` header pill (1r Daemon) — both via the mobile
  `mobile/v3/m-connection` tone/pulse mapping (pure, tested). `useConnectionStatus()` defaults to
  `connecting` before the provider's first state change (accurate — the link has not connected yet).
- Verified live: the `events: []` subscription against the real ui-http-server immediately returns
  `event: connected` and holds the stream open → the link reaches `pending` → badge = connected.
