Please update me when files in this folder change

Platform abstraction layer: core modules reach Slack, Feishu, and the TUI through one adapter interface.
Concrete SDK integrations live in adapters/.

| filename | role | function |
|---|---|---|
| index.ts | entry | Exports platform APIs and live update helpers |
| adapter.ts | interface | Defines adapter lifecycle and live updates |
| types.ts | types | Message, block, and modal type definitions |
| output-stream.ts | interface | OutputStream and MutableRegion contracts |
| output-stream-chunk.ts | util | Splits long text into postable chunks |
| output-stream-helpers.ts | util | Posts a single message via a temporary stream |
| interactive-builder.ts | builder | Builds question and plan approval components |
| tool-trace.ts | ui | Renders compact tool call traces |
| testing.ts | testing | Records calls and supports live admin updates |
| adapters/ | subdir | Concrete platform adapter implementations |
| tui/ | subdir | TUI wire protocol contract |
| ui-http/ | subdir | Web UI HTTP and SSE transport host |
| utils/ | subdir | Shared platform utilities |
