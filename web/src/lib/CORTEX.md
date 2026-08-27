Please update me when files in this folder change

Non-visual client infrastructure shared by every screen.
Builds the tRPC client, reads native-shell credentials, centralizes typed native capabilities, moves workspace files and owns canonical formatting.

| filename | role | function |
|---|---|---|
| trpc.ts | core | Creates the tRPC client and React context |
| trpc.test.ts | test | Unit tests for URL and headers per transport mode |
| desktop-config.ts | util | Detects guarded native shells and supplies auth details |
| desktop-config.test.ts | test | Unit tests for shell detection and auth headers |
| external-navigation.ts | util | Opens HTTP links in browser and native shells |
| external-navigation.test.ts | test | Tests native opener and legacy fallback paths |
| native-bridge.ts | core | Runtime-checks the sole `__TAURI__` boundary and provides typed safe invoke plus idempotent event/back listeners |
| native-bridge.test.ts | test | Tests absent/partial bridges, command failures, unknown event payloads and listener teardown races |
| shell-connection.ts | util | Safely clears native credentials through the canonical bridge and reopens the connect screen |
| shell-connection.test.ts | test | Unit tests for the disconnect path |
| files.ts | util | Downloads, previews and reveals workspace files through HTTP or typed native commands |
| files.test.ts | test | Unit tests for download URL building |
| build-info.ts | util | Exposes the injected build stamp with a fallback |
| format.ts | util | Canonically formats fixed-precision USD and strategy-driven binary byte labels |
| format.test.ts | test | Tests USD precision plus byte unit, fraction and trimming strategies |
