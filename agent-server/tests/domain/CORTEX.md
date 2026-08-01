Please update me when files in this folder change

Domain-layer tests, one folder per business capability of the agent server.

| filename | role | function |
|---|---|---|
| agent-run/ | subdir | run journals, manifests and process containment |
| agents/ | subdir | agent profile resolution and switching |
| auth-login-service.test.ts | test | Auth consumer selection and cancellation fencing |
| auth-status.test.ts | test | Auth state, capability preference and output |
| cc-login.test.ts | test | Claude API-key persistence, concurrency and recovery |
| cc-subscription.test.ts | test | Claude subscription security, expiry, and cancellation |
| login-flow.test.ts | test | Covers login outcomes, safe errors, and abort scopes |
| pi-login.test.ts | test | PI login receipts and safe failure payloads |
| pi-oauth.test.ts | test | PI OAuth expiry, notices, aborts and failures |
| costs/ | subdir | cost attribution and summary reporting |
| hook-view.test.ts | test | mount targets, result modes and apply time |
| mcp/ | subdir | MCP tool registration and handlers |
| sessions/ | subdir | session registration and lifecycle |
| system/ | subdir | self-diagnosis and operator notices |
| tasks/ | subdir | task mutation, locking, and write guards |
| tui-session/ | subdir | TUI session handshake and switching |
| ui-service/ | subdir | UI query, mutation, and subscription surface |
