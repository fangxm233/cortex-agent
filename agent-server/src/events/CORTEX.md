Please update me when files in this folder change

In-process event bus, typed event contract, and event log for agent-server.
Other layers publish state changes here and subscribers observe them.

| filename | role | function |
|---|---|---|
| event-bus.ts | core | publishes events to subscribers |
| event-logger.ts | logger | writes hot-toggleable daily event logs |
| event-replay.ts | cli | prints logged events for a chosen day |
| event-types.ts | types | declares Cortex and authentication event contracts |
| index.ts | barrel | exports the public events API and types |
