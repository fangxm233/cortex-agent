# features/live/ — the app's single live-event stream (shared SSE + client-side fan-out)

Every live surface in the UI (chat transcript, rail running dots, threads panel, each expanded thread
card, tasks panel, DM notification toasts, system notices, the daemon connectivity badge) reads server
events from **one** SSE subscription mounted per shell, instead of opening its own.

**Why**: tRPC's `httpSubscriptionLink` opens one `EventSource` per `subscribe()` call — it does not
multiplex. Each live hook subscribed independently, so a loaded workbench held **six** concurrent SSE
connections: the connectivity probe (an empty event set, purely to watch the link state), DM
notifications, system notices, the rail's session sync, the center chat, the threads panel — plus one
per expanded thread card and one for the tasks tab. Six is exactly a browser's per-origin connection
cap over HTTP/1.1, so with the budget spent every other request queued forever: attachment thumbnails
never loaded and uploads hung (curl to the same URL returned in milliseconds). Over the Cloudflare
tunnel the browser speaks HTTP/2 and multiplexes, which is why this only bit **direct plain-HTTP
origins** (`http://127.0.0.1:3005`, LAN access, the vite dev server) — the agent-server's ui-http is
`node:http`, HTTP/1.1 only.

The server was already capable of this: `createSubscription` (agent-server
`domain/ui-service/subscribe.ts`) takes a list of event types and post-filters by
session/project/execution id. One stream carrying the union was always supported; only the client
side had to change. The later profile-refresh path adds only a typed `config.changed` hint on the server; it still reuses this same stream. `session.debug.updated` is likewise content-free and triggers an authoritative transcript refetch only after lossless DEBUG metadata is durable.

| path | role |
|---|---|
| `live-events.ts` / `live-events.test.ts` | **Pure** (TDD). `LIVE_EVENT_TYPES` — the **fixed** union the shared stream subscribes to, composed of the per-domain groups `SESSION_LIVE_EVENTS` / `THREAD_LIVE_EVENTS` / `TASK_LIVE_EVENTS` / `SYSTEM_LIVE_EVENTS` / `CONFIG_LIVE_EVENTS` (a test asserts every group is contained in the union, so adding an event type to a group can't silently fail to reach its hook). `isProfileConfigChanged` recognizes only the typed successful `profiles.json` reload hint; the provider then invalidates `config.get`, so every mounted desktop/mobile profile surface refetches without a page reload. `SESSION_LIVE_EVENTS` includes **`session.message.delivered`** — the commit for a message written into a running turn's backend but not yet read by the model; without it on the stream such a message would stay dimmed forever, so a test names it explicitly. Unlike the token-level preview it is rare and load-bearing, and the server does not restrict it to session-scoped subscriptions, so the shared (unscoped) stream does receive it. Fixed rather than reference-counted over mounted listeners: the union is small and known, and a dynamic one would tear down and re-open the SSE whenever a live surface mounts. It costs nothing extra in bandwidth — the app already received every session event unscoped (DM notifications did). `matchesLiveEvent(ev, types, scope?)` — type membership + the session scope filter, which **reproduces the server's post-filter semantics verbatim**, including that an event carrying **no** `sessionId` passes a scoped listener (`subscribe.ts`: `if (sessionId && event.sessionId && …)`); that parity is what makes moving the previously server-scoped chat subscription onto the shared stream behaviour-preserving. `dispatchLiveEvent(listeners, ev)` — fan-out, **containing a throwing listener** (with per-hook subscriptions a throw killed only that hook's own connection; on a shared stream it would take every surface down). `applyConnState` / `initialConnAccum` — the has-ever-connected latch + `epoch`, bumped only when the stream re-enters `pending` **after a drop**; this replaces the `wasConnected` flag each live-sync hook used to keep. |
| `LiveEventsProvider.tsx` | Owns the single `client.subscribe.subscribe({ events: LIVE_EVENT_TYPES })` and the listener set. `useLiveEvents(types, handler, scope?)` registers a listener — the handler is read through a ref, so it does **not** need to be stable and a re-render never touches the connection; re-registration happens only when the listened types or the scope change. `useLiveConnection()` exposes `{ connState, hasConnected, reconnectEpoch }`. Mounted **outermost** in `shell/AppShell` (desktop) and `mobile/MobileShell` (mobile). |

## Consumers

| hook / provider | events | scope |
|---|---|---|
| `workbench/useSessionMessageLiveSync` | session.message / message.delivered / status / turn / interaction / rewound / debug.updated | `{ sessionId }` — the open chat |
| `workbench/useSessionsLiveSync` | session.status / interaction | global (rail dots) |
| `workbench/useThreadsLiveSync` | thread lifecycle | global (`threads.list`) |
| `thread/useThreadGetLiveSync` | thread lifecycle | global (`threads.get` for one id) |
| `tasks/useTasksLiveSync` | task lifecycle | global (`tasks.list`) |
| `notifications/useDmNotifications` | session.message / status | global (toast queue) |
| `notifications/useSystemNotices` | system.notice | global |
| `LiveEventsProvider` config sync | config.changed(section=profiles) | global; invalidates `config.get` |
| `connection/ConnectionStatusProvider` | — | reads `useLiveConnection()` only |

`ConnectionStatusProvider` no longer opens anything: it used to spend a whole connection on an
empty-event subscription just to observe `onConnectionStateChange`. It now derives the badge from the
shared stream's state + `hasConnected` latch (the pure `deriveConnectionStatus` is unchanged).

**Not merged**: `execution/useExecutionLogStream` — a different procedure (`executions.log`),
executionId-scoped, high-volume, and open only while the log drawer is.

**Also not merged**: `session.message.delta` (token-level assistant streaming), exported here as
`ASSISTANT_DELTA_EVENTS` but deliberately kept OUT of `LIVE_EVENT_TYPES` — a test asserts the
exclusion so it can't drift back in. The server hands these out only to a subscription that names
their session (`SESSION_SCOPED_ONLY` in agent-server `domain/ui-service/subscribe.ts`), because a
preview is renderable by exactly one surface and an unscoped app-wide stream taking every session's
previews would fill its 256-slot server queue and drop-oldest the status / thread / task events it
exists to deliver. They ride `workbench/useAssistantDeltaStream`, opened by the open chat only — the
same treatment `executions.log` gets. Two connections on a loaded workbench, against the six that
caused the starvation this directory exists to fix.

## Reconnect

One stream means one reconnect signal. `reconnectEpoch` changes only on a **re**-connect (never on the
first connect), and `useSessionMessageLiveSync` refetches `sessions.list` + `sessions.transcript` when
it changes — the same recovery the hook did with its own `wasConnected` latch, now shared, so a drop
produces one coordinated refetch round instead of six independent ones.

## Verified live

Production build served over plain HTTP/1.1 against the real ui-http server, headless-Chrome CDP
(2026-07-25):

- **1** `/trpc/subscribe` request after loading `/workbench` (was 6), still **1** after opening the
  Tasks tab and thread cards.
- Daemon badge: green `connected` → amber `reconnecting` while the serving process is killed → green
  `connected` after it returns, with automatic re-subscription (subscribe requests 1 → 3 incl. retries)
  and a query refetch across the drop. No probe connection involved.
- The attachment/preview flow (thumbnail fetch → lightbox → pinned pane) now completes **without** the
  `Network.setBlockedURLs('*trpc/subscribe*')` workaround the harness previously required — the
  end-to-end proof that the connection starvation is gone.
- 0 console errors; `web` suite 1251/1251, `tsc --noEmit` clean.
