Please update me when files in this folder change

Non-visual client infrastructure shared by every screen.
Builds the tRPC client, reads native-shell credentials and moves workspace files.

| filename | role | function |
|---|---|---|
| trpc.ts | core | Creates the tRPC client and React context |
| trpc.test.ts | test | Unit tests for URL and headers per transport mode |
| desktop-config.ts | util | Detects native shells and supplies auth details |
| desktop-config.test.ts | test | Unit tests for shell detection and auth headers |
| shell-connection.ts | util | Clears credentials and reopens the connect screen |
| shell-connection.test.ts | test | Unit tests for the disconnect path |
| files.ts | util | Downloads, previews and reveals workspace files |
| files.test.ts | test | Unit tests for download URL building |
| build-info.ts | util | Exposes the injected build stamp with a fallback |
