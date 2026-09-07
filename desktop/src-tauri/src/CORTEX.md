Please update me when files in this folder change

Rust source of the Cortex native shell: startup, credentials, local install, and frontend delivery.
Provides SPA commands, native plugins, frontend delivery, and updates.

| filename | role | function |
|---|---|---|
| main.rs | entry | starts the native application |
| lib.rs | core | Builds the shell and isolates frame initialization |
| creds.rs | core | stores and loads the server credentials |
| app_update.rs | core | checks, downloads and installs shell updates |
| frontend.rs | core | Resolves embedded setup assets and OTA workbench |
| ota.rs | core | fetches and stages new frontend versions |
| setup.rs | core | Async local setup commands and startup lifecycle |
| setup_package.rs | util | Validates setup package and installed version |
| setup_process.rs | util | Runs setup processes with token-safe progress |
| forward.rs | core | forwards a server loopback port to a local port (desktop) |
| forward_stub.rs | core | refusing stand-in for the forward on Android |
| seed.rs | util | supplies the initial frontend on Android |
