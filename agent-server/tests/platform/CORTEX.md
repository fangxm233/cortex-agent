Please update me when files in this folder change

Regression tests for the platform layer: adapter composition, the TUI
gateway and wire protocol, and the Web UI HTTP transport.

| filename | role | function |
|---|---|---|
| adapter-factory.test.ts | test | Covers platform adapter selection and mix |
| app-update.test.ts | test | Covers app shell update manifest and route |
| composite-adapter.test.ts | test | Covers multi-platform routing and fan-out |
| interactive-builder.test.ts | test | Covers ask-card level banner and modal prefix |
| tui-gateway.test.ts | test | Covers TUI gateway sessions and delivery |
| tui-protocol.test.ts | test | Covers TUI frame parsing and encoding |
| tui-transcript.test.ts | test | Covers TUI transcript replay building |
| ui-http-app-router.test.ts | test | Covers tRPC route mapping and errors |
| ui-http-lazy-driver.mjs | util | Drives the transport lazy-load check |
| ui-http-lazy-hooks.mjs | util | Records resolved module specifiers |
| ui-http-lazy-load.test.ts | test | Covers lazy loading of the UI transport |
| ui-http-server.test.ts | test | Covers transport, wiring, auth gate (token + Access JWT), CORS, SPA, OTA, download |
| ui-ota.test.ts | test | Covers desktop UI OTA manifest and bundle |
| zip-writer.test.ts | test | Covers deterministic ZIP encoding |
