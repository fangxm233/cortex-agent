Please update me when files in this folder change.

Rust shell commands and native desktop/Android integration.

| filename | role | function |
|---|---|---|
| app_update.rs | core | Download and install native shell updates |
| clipboard_history.rs | adapter | Integrate Windows clipboard history |
| creds.rs | utility | Persist native connection credentials |
| desktop_notifications/ | adapter | Deliver and route desktop notification clicks |
| forward.rs | core | Relay desktop TCP connections over WebSocket |
| forward_stub.rs | adapter | Refuse port forwarding on Android |
| frontend.rs | adapter | Serve frontend assets through a custom scheme |
| install_site.rs | utility | Classify installation and update eligibility |
| lib.rs | entry | Compose shell state, commands and runtime |
| main.rs | entry | Launch the desktop application |
| mobile_notifications.rs | adapter | Configure Android notification service |
| native_menu.rs | adapter | Synchronize the native application menu |
| ota.rs | core | Stage and promote frontend updates |
| seed.rs | utility | Extract the embedded Android frontend seed |
| setup.rs | core | Orchestrate local server setup |
| setup_claude.rs | utility | Configure local Claude integration |
| setup_package.rs | utility | Install local server packages |
| setup_process.rs | utility | Manage local setup processes |
| update_checks.rs | core | Check and apply eligible updates |
| update_checks_tests.rs | test | Verify update decisions and failure handling |
| update_prefs.rs | utility | Persist update preferences and failure counters |
