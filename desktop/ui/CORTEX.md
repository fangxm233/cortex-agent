Please update me when files in this folder change.

Standalone, theme-aware setup screens embedded in the native shell.
The shell runs undecorated, so these pages draw their own title bar: drag region, and
caption buttons on Windows/Linux, matching the SPA's provider-setup header.

| filename | role | function |
|---|---|---|
| connect.html | page | Chooses installation or an existing server |
| setup.html | page | Present PI-only setup and compact local settings |
| shell.css | style | Align setup and its app-drawn title bar with the workbench |
| shell.js | shared | Apply language and draw the native window title bar |
| connect.js | core | Tests and saves remote server connections |
| setup-flow.js | core | Connect and hand new installs to provider setup |
| setup.js | view | Render PI-only form, progress and setup handoff |
