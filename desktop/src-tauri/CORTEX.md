Please update me when files in this folder change

Rust crate for the Cortex native app: the Tauri shell that hosts the web SPA.
Holds the app manifest, Tauri configuration, security capabilities, and icons.

| filename | role | function |
|---|---|---|
| build.rs | script | generates Tauri build artifacts |
| Cargo.toml | config | declares the crate and its dependencies |
| Cargo.lock | config | pins exact dependency versions |
| tauri.conf.json | config | configures the app bundle and window |
| capabilities/ | subdir | permission grants for the app window |
| icons/ | subdir | app and launcher icon images |
| src/ | subdir | the Rust shell source code |
