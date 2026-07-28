Please update me when files in this folder change

Local Tauri plugin that saves app files into the public Android Downloads folder.
Ships the Rust command, its permission grants, and the Android library.

| filename | role | function |
|---|---|---|
| build.rs | script | generates the permission set and Android wiring |
| Cargo.toml | config | declares the plugin crate and its dependencies |
| android/ | subdir | Android library that performs the download |
| permissions/ | subdir | permission definitions for the download command |
| src/ | subdir | the Rust plugin source code |
