Please update me when files in this folder change

Session domain — stateful session lifecycle (CRUD + registry + backup + hooks), not to be confused with the TUI session layer (`tui-session/`).

| filename | role | function |
|---|---|---|
| `session.ts` | persistence | get/set/deleteSessionAsync — re-exports from store/session-repo |
| `session-registry.ts` | persistence | sessionStore re-export + lookupSessionName helper (store/session-registry-repo) |
| `session-backup.ts` | persistence | Claude session JSONL per-turn backup and restore |
| `session-hooks.ts` | lifecycle | Unified onNew/onMessageEnd hook pipeline — spawn + OutputStream display + optional agent injection (onNew pre-close turn runs on an isolated pool key via `onNewInjectSessionKey`, closed after, so `!new` does not resurrect the old session onto the channel slot) |
| `session-lifecycle.ts` | lifecycle | Session id model: the registry `sessionId` (key) is the STABLE TRACK id (UI identity, channel binding, publish/history key), decoupled from the backend CLI's own session id which lives in the record's `backendSessionId` (resume target + backup file name; see store/session-registry-repo `effectiveBackendSessionId`). Both Claude and PI self-assign the backend id (Claude generates one for `--session-id`; PI at bootstrap), captured from the turn result and stored WITHOUT rebinding the channel/registry. Shared session-lifecycle primitives: registerNamedSession, attachExistingSession, resetChannelSession, createDirectSession (mint a fresh origin='direct' web/UI session on its own `web:<sessionId>` channel + bind sessions.json/ledger so a later send resumes it — backs the ui-service `sessions.create` op) |
