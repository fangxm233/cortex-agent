Please update me when files in this folder change

`agent-server/src/events/` — S4 EventBus and async observability infrastructure.
Only depends on core/, constructed and connected by entry/app.ts, not yet connected to any production publishers (S5/S6 handle that).

| filename | role | function |
|---|---|---|
| `event-types.ts` | types | CortexEvent union type (user events + 2 meta events; incl. `execution.log` live log-tail stream, `session.message` S4 chat live stream — sessionId/channel/role/text, published at agent-runner's conversation-history append points, and `session.status` — sessionId/channel/running, the REAL per-turn running indicator emitted by agent-runner at turn start/finally) + CortexEventInput (distributive Omit) |
| `event-bus.ts` | core | EventBus: subscribe / publish (synchronous fan-out) / registerCloseHook / close() |
| `event-logger.ts` | observability | createEventLogger: ring buffer 1024, 100ms flush, daily rolling jsonl, 14-day retention, CORTEX_EVENT_LOG=off escape hatch |
| `event-replay.ts` | debug | CLI: `node events/event-replay.ts --date YYYY-MM-DD [--type xxx]` |
| `index.ts` | export | External barrel: EventBus / Subscription / CortexEvent / CortexEventInput / createEventLogger |
