Please update me when files in this folder change

Native shell credentials, frontend serving, downloads, and OTA logic.

| filename | role | function |
|---|---|---|
| creds.rs | store | Loads, saves, and clears native credentials |
| frontend.rs | resolver | Resolves embedded and on-disk frontend assets |
| lib.rs | core | Registers native commands and starts the shell |
| main.rs | entry | Starts the desktop application |
| ota.rs | update | Downloads, verifies, and stages frontend updates |
| seed.rs | bootstrap | Installs the embedded Android frontend seed |
