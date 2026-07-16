Please update me when files in this folder change

`agent-server/src/events/` — S4 EventBus and async observability infrastructure.
Only depends on core/, constructed and connected by entry/app.ts, not yet connected to any production publishers (S5/S6 handle that).

| filename | role | function |
|---|---|---|
| `event-types.ts` | types | CortexEvent union type (user events + 2 meta events; incl. `execution.log` live log-tail stream, `session.message` S4 chat live stream — sessionId/channel/role/text, published at agent-runner's conversation-history append points, and `session.status` — sessionId/channel/running (+ optional `backgroundRunning`), the REAL per-turn running indicator emitted by agent-runner at turn start/finally; `backgroundRunning` marks the web bg-hold window (foreground turn done, a background task still running — running stays true) so the Web composer shows a distinct "background" state instead of sealing idle (web-bg-hold.ts); and `session.turn` — sessionId/channel/numTurns, the REAL live agent-turn count emitted by agent-runner on each turn_progress so the Web composer shows turns that grow as the agent works; and `system.notice` — level/text/title, the encapsulated admin/system broadcast (startup, restart, profile/config/machine hot-reload, disk, rate-limit) published via `domain/system/system-notice.emitSystemNotice` and surfaced by the Web notification toaster) + CortexEventInput (distributive Omit) |
| `event-bus.ts` | core | EventBus: subscribe / publish (synchronous fan-out) / registerCloseHook / close() |
| `event-logger.ts` | observability | createEventLogger: ring buffer 1024, 100ms flush, daily rolling jsonl, 14-day retention, CORTEX_EVENT_LOG=off escape hatch |
| `event-replay.ts` | debug | CLI: `node events/event-replay.ts --date YYYY-MM-DD [--type xxx]` |
| `index.ts` | export | External barrel: EventBus / Subscription / CortexEvent / CortexEventInput / createEventLogger |
