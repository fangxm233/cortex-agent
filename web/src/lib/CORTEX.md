Please update me when files in this folder change

Non-visual client infrastructure shared by every screen.
Owns transport, native capabilities, retained actions and file utilities.

| filename | role | function |
|---|---|---|
| trpc.ts | core | Creates the tRPC client and React context |
| trpc.test.ts | test | Unit tests for URL and headers per transport mode |
| desktop-config.ts | util | Detects guarded native shells and supplies auth details |
| desktop-config.test.ts | test | Unit tests for shell detection and auth headers |
| external-navigation.ts | util | Opens HTTP links in browser and native shells |
| external-navigation.test.ts | test | Tests native opener and legacy fallback paths |
| native-bridge.ts | core | Typed native calls, on-screen session reports and scoped retained taps; register-before-drain, focus/resume drains and five foreground retries (1–16s), with handled-ID dedup and timer/listener teardown |
| native-bridge.test.ts | test | Tests native capabilities and listener teardown |
| native-notifications.test.ts | test | Tests retained tap scope, route/status/ack retry recovery, bounded foreground backoff, idle queues and in-flight teardown |
| shell-connection.ts | util | Safely clears native credentials through the canonical bridge and reopens the connect screen |
| shell-connection.test.ts | test | Unit tests for the disconnect path |
| files.ts | util | Downloads, previews and reveals workspace files through HTTP or typed native commands |
| files.test.ts | test | Unit tests for download URL building |
| build-info.ts | util | Exposes the injected build stamp with a fallback |
| format.ts | util | Canonically formats fixed-precision USD and strategy-driven binary byte labels |
| format.test.ts | test | Tests USD precision plus byte unit, fraction and trimming strategies |
