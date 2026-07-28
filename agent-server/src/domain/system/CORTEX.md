Please update me when files in this folder change

Server auto-update domain layer (DR-0013). Platform-agnostic interfaces and data types for
the auto-update subsystem. Platform-specific implementations (Slack, Feishu, TUI) live in
orchestration/interactions/.

| filename | role | function |
|---|---|---|
| `update-prompt.ts` | interface | UpdateChoice type + UpdatePrompt interface with ask(spec) method |
| `update-state.ts` | I/O | loadUpdateState / saveUpdateState for update-state.json (skipped version persistence) |
| `server-update-check.ts` | checker | compareCalVer, isUpdateDevMode, checkServerUpdate — core update-check flow |
| `github-release.ts` | client | fetchReleaseNote(version) — GitHub API client with 24h TTL cache for release notes |
| `install-cli.ts` | CLI | cortex install latest — fetch latest version from npm and run npm install -g |
| `doctor.ts` | engine | Pure health-check engine for `cortex doctor` — runDiagnostics/applySafeFixes + default real-env deps (runtime, backend/login, platform, gateway) |
