Please update me when files in this folder change

Single source of truth for UI to agent-server connectivity, derived from the shared live stream link state.
Feeds the daemon badge with a status plus its dot color, pulse and label.

| filename | role | function |
|---|---|---|
| ConnectionStatusProvider.tsx | provider | Publishes link status from the live stream |
| connection-status.ts | vm | Maps link state to display status and tokens |
| connection-status.test.ts | test | Unit tests for connection status mapping |
