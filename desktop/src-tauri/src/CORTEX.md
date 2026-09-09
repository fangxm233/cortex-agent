Please update me when files in this folder change

Native shell startup, credentials, local setup, and frontend delivery.
Provides SPA commands, native plugins, frontend delivery, and updates.

| filename | role | function |
|---|---|---|
| main.rs | entry | starts the native application |
| lib.rs | core | Register shell IPC and compact desktop chrome |
| mobile_notifications.rs | adapter | Configure native notifications with shell credentials |
| creds.rs | core | stores and loads the server credentials |
| app_update.rs | core | checks, downloads and installs shell updates |
| frontend.rs | core | Resolves embedded setup assets and OTA workbench |
| ota.rs | core | fetches and stages new frontend versions |
| setup.rs | core | Compose local setup and startup lifecycle |
| setup_claude.rs | core | Guard local Claude Code detection and installation |
| setup_package.rs | util | Validates setup package and installed version |
| setup_process.rs | util | Resolve CLIs and stream token-safe setup progress |
| forward.rs | core | forwards a server loopback port to a local port (desktop) |
| forward_stub.rs | core | refusing stand-in for the forward on Android |
| seed.rs | util | Restore compatible frontend on APK or legacy OTA |
