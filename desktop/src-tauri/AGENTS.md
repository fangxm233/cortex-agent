Please update me when files in this folder change.

Tauri shell crate, platform dependencies and native application resources.

| filename | role | function |
|---|---|---|
| build.rs | build | Generate Tauri build metadata |
| capabilities/ | config | Define native capability permissions |
| Cargo.lock | config | Pin native dependency versions |
| Cargo.toml | config | Declare target-specific native dependencies |
| icons/ | asset | Supply application and installer icons |
| src/ | core | Implement shell commands and platform adapters |
| tauri.conf.json | config | Configure shell resources and packaging |
| tests/ | test | Run scoped native integration tests |
