Please update me when files in this folder change

Domain-layer tests, one folder per business capability of the agent server.

| filename | role | function |
|---|---|---|
| agent-run/ | subdir | run journals, manifests and process containment |
| agents/ | subdir | agent profile resolution and switching |
| benchmark/ | subdir | benchmark arm and policy compilation |
| auth-logout.test.ts | test | Isolated auth logout ownership, state and privacy |
| auth-login-service.test.ts | test | Auth selection, notice reuse and cancel fencing |
| auth-status.test.ts | test | Auth state, CLI authority, capabilities and output |
| auth-gateway-sync.test.ts | test | Post-login gateway and profile regeneration |
| auth-login-success-hook.test.ts | test | Login success listener delivery and isolation |
| cc-auth-cli.test.ts | test | Claude auth command I/O, privacy and lifecycle |
| cc-login.test.ts | test | Isolated key login, persistence and recovery |
| cc-subscription.test.ts | test | Claude subscription relay, cleanup and recovery |
| claude-user-settings.test.ts | test | Claude settings cleanupPeriodDays path, merge, atomic temp-write, race retry, symlink, and guard coverage |
| login-flow.test.ts | test | Covers login outcomes, safe errors, and abort scopes |
| pi-custom-providers.test.ts | test | Custom PI provider validation, storage and rollback |
| pi-login.test.ts | test | PI login receipts and safe failure payloads |
| pi-oauth.test.ts | test | PI OAuth expiry, notices, aborts and failures |
| plugins/ | subdir | Plugin catalog schema and discovery regressions |
| commissions/ | subdir | commission projection and context loading |
| costs/ | subdir | cost attribution and summary reporting |
| hook-view.test.ts | test | mount targets, result modes and apply time |
| mcp/ | subdir | MCP tool registration and handlers |
| remote/ | subdir | reverse stream pairing and device port mapping |
| sessions/ | subdir | session registration and lifecycle |
| system/ | subdir | self-diagnosis and operator notices |
| tasks/ | subdir | task mutation, locking, and write guards |
| tui-session/ | subdir | TUI session handshake and switching |
| ui-service/ | subdir | UI query, mutation, and subscription surface |
