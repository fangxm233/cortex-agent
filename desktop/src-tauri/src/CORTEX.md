Please update me when files in this folder change

Rust source of the Cortex native shell: startup, credentials, local install, and frontend delivery.
Provides SPA commands, native plugins, frontend delivery, and updates.

| filename | role | function |
|---|---|---|
| main.rs | entry | starts the native application |
| lib.rs | core | Builds plugins, commands, scheme, and app window |
| creds.rs | core | stores and loads the server credentials |
| app_update.rs | core | checks, downloads and installs shell updates |
| frontend.rs | core | resolves SPA requests to frontend assets |
| ota.rs | core | fetches and stages new frontend versions |
| setup.rs | core | installs, configures and starts a local server |
| seed.rs | util | supplies the initial frontend on Android |
