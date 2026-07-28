Please update me when files in this folder change

Native app package: wraps the Cortex web SPA in a Tauri v2 shell for desktop and Android.
Serves the SPA locally, stores the server credentials, and keeps the frontend up to date.

| filename | role | function |
|---|---|---|
| package.json | config | Package manifest and build scripts |
| scripts/ | subdir | Android release and icon build scripts |
| src-tauri/ | subdir | Rust Tauri application crate |
| tauri-plugin-cortex-download/ | subdir | Local Tauri plugin for Android downloads |
| ui/ | subdir | Standalone connection setup page |
