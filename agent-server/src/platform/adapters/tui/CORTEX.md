Please update me when files in this folder change

TUI adapter: exposes localhost WebSocket clients through the PlatformAdapter interface.
Holds per-connection state and emits assistant output as protocol frames.

| filename | role | function |
|---|---|---|
| index.ts | entry | Re-exports the TUI adapter public API |
| tui-gateway.ts | adapter | Serves TUI WebSocket clients as a PlatformAdapter |
| tui-connection.ts | connection | Wraps one WebSocket client connection |
| tui-conduit-state.ts | state | Tracks session and project per conduit |
| tui-output-stream.ts | stream | Emits assistant output as stream frames |
| tui-transcript.ts | format | Rebuilds past messages into replay frames |
| tui-notifications.ts | notify | Fans project reports and notices to clients |
| ports.ts | types | Boundary types for transcript and queue input |
