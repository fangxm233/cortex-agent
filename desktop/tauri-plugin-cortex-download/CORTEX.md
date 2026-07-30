Please update me when files in this folder change

Local Tauri plugin for Android: saves files to public Downloads and hands APKs to the installer.
Ships the Rust commands, their permission grants, and the Android library.

| filename | role | function |
|---|---|---|
| build.rs | script | generates the permission set and Android wiring |
| Cargo.toml | config | declares the plugin crate and its dependencies |
| android/ | subdir | Android library: downloads and APK install |
| permissions/ | subdir | permission definitions for the download command |
| src/ | subdir | the Rust plugin source code |
