Please update me when files in this folder change

Native app package: wraps the Cortex web SPA in a Tauri v2 shell for desktop and Android.
Serves the SPA, stores credentials, opens system URLs, and updates the frontend and shell.

| filename | role | function |
|---|---|---|
| package.json | config | Native build and focused onboarding test scripts |
| scripts/ | subdir | Android release and icon build scripts |
| src-tauri/ | subdir | Rust Tauri application crate |
| tauri-plugin-cortex-download/ | subdir | Android downloads and APK install plugin |
| tauri-plugin-cortex-notifications/ | subdir | Background notifications and retained tap routing |
| ui/ | subdir | Embedded connection and automatic setup screens |
| tests/ | subdir | Focused onboarding behavior and asset checks |
