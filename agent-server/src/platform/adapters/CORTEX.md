Please update me when files in this folder change

Concrete PlatformAdapter implementations for Slack, Feishu, and the TUI.
CompositeAdapter runs several platforms at once and routes each conduit to its owning adapter.

| filename | role | function |
|---|---|---|
| index.ts | factory | Builds adapters from credentials and settings |
| composite-adapter.ts | adapter | Routes conduits and live platform settings |
| slack.ts | adapter | Slack messaging and admin channel persistence |
| slack-output-stream.ts | stream | Streams coalesced assistant output to Slack |
| feishu.ts | adapter | Feishu messaging, rich-text links, forms and routing |
| feishu-output-stream.ts | stream | Streams assistant output into one Feishu card |
| project-conduits.ts | store | File-backed project to conduit mapping |
| slack-project-conduits.ts | compat | Alias export of the project conduit store |
| tui/ | subdir | TUI WebSocket gateway adapter |
