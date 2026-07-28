Please update me when files in this folder change

Rust source of the Cortex native shell: startup, credentials, and frontend delivery.
Provides the commands the web SPA calls for connection, downloads, and updates.

| filename | role | function |
|---|---|---|
| main.rs | entry | starts the native application |
| lib.rs | core | builds the app, its commands, and its window |
| creds.rs | core | stores and loads the server credentials |
| frontend.rs | core | resolves SPA requests to frontend assets |
| ota.rs | core | fetches and stages new frontend versions |
| seed.rs | util | supplies the initial frontend on Android |
