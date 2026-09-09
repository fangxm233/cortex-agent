Please update me when files in this folder change.

Native shell startup, credentials, local setup, and frontend delivery.
Coordinates native update checks and user-confirmed installation.

| filename | role | function |
|---|---|---|
| main.rs | entry | Start the native application |
| lib.rs | core | Register shell IPC and desktop chrome |
| mobile_notifications.rs | adapter | Configure native notification credentials |
| native_menu.rs | adapter | Synchronize the macOS application menu |
| creds.rs | core | Store and load server credentials |
| app_update.rs | core | Select, verify, and install shell updates |
| update_checks.rs | core | Coordinate update checks and guarded update IPC |
| update_checks_tests.rs | test | Test update outcomes, HTTP, and mutual exclusion |
| frontend.rs | core | Resolve embedded setup assets and OTA workbench |
| ota.rs | core | Fetch fresh manifests and preserve staged UI |
| setup.rs | core | Compose local setup and startup lifecycle |
| setup_claude.rs | core | Guard Claude Code detection and installation |
| setup_package.rs | utility | Validate setup package and installed version |
| setup_process.rs | utility | Resolve CLIs and stream safe setup progress |
| forward.rs | core | Forward server loopback ports on desktop |
| forward_stub.rs | core | Refuse port forwarding on Android |
| seed.rs | utility | Restore compatible frontend seeds |
