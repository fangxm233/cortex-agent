Please update me when files in this folder change.

Android background notifications and durable tap routing for the native shell.

| filename | role | function |
|---|---|---|
| .gitattributes | config | Preserve captured SSE whitespace |
| .gitignore | config | Exclude generated permission assets |
| Cargo.toml | config | Declare the native notification crate |
| build.rs | script | Generate command grants and Android wiring |
| src/ | subdir | Expose native commands and configuration |
| android/ | subdir | Own background connection and notifications |
| permissions/ | subdir | Grant notification bridge commands |
