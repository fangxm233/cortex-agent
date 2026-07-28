Please update me when files in this folder change

Concrete PlatformAdapter implementations for Slack, Feishu, and the TUI.
CompositeAdapter runs several platforms at once and routes each conduit to its owning adapter.

| filename | role | function |
|---|---|---|
| index.ts | factory | Selects and composes adapters per config |
| composite-adapter.ts | adapter | Routes calls to the adapter owning a conduit |
| slack.ts | adapter | Slack messaging, files, and reaction markers |
| slack-output-stream.ts | stream | Streams coalesced assistant output to Slack |
| feishu.ts | adapter | Feishu messaging, files, cards, and markers |
| feishu-output-stream.ts | stream | Streams assistant output into one Feishu card |
| project-conduits.ts | store | File-backed project to conduit mapping |
| slack-project-conduits.ts | compat | Alias export of the project conduit store |
| tui/ | subdir | TUI WebSocket gateway adapter |
