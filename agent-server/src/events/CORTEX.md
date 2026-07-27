Please update me when files in this folder change

`agent-server/src/events/` — S4 EventBus and async observability infrastructure.
Only depends on core/, constructed and connected by entry/app.ts, not yet connected to any production publishers (S5/S6 handle that).

`session.debug.updated` is a content-free post-persistence hint. Sensitive prompts, inputs, results, and tool ids never ride the EventBus; clients refetch the authenticated, DEBUG-gated transcript query.

| filename | role | function |
|---|---|---|
| `event-types.ts` | types | CortexEvent union with timestamped context/notices/pending/deltas/lifecycle events plus the content-free `rate-limit.changed` query-refresh hint. |
| `event-bus.ts` | core | EventBus: subscribe / publish (synchronous fan-out) / registerCloseHook / close() |
| `event-logger.ts` | observability | createEventLogger: ring buffer 1024, 100ms flush, daily rolling jsonl, 14-day retention, CORTEX_EVENT_LOG=off escape hatch. Skips META_EVENTS (re-entrancy) and TRANSIENT_EVENTS — `session.message.delta`, dozens per reply and fully repeated by the complete `session.message`, so logging it would multiply the daily jsonl and evict real events from the ring buffer |
| `event-replay.ts` | debug | CLI: `node events/event-replay.ts --date YYYY-MM-DD [--type xxx]` |
| `index.ts` | export | External barrel: EventBus / Subscription / CortexEvent / CortexEventInput / createEventLogger |
