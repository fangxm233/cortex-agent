Please update me when files in this folder change

TUI protocol layer. Contract between M1 (TUI gateway adapter) and M5 (Ink client).

| filename | role | function |
|---|---|---|
| `protocol.ts` | types + wire | M4 `TuiFrame` discriminated union, representative runtime guards, parse/encode codec, and protocol version. Runtime guard behavior is tested without maintaining duplicate frame-type/guard inventories. |
