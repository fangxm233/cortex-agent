Please update me when files in this folder change

Core infrastructure tests: paths, config and profile generation, auth, locks, i18n, and debug policy.

| filename | role | function |
|---|---|---|
| atomic-write-guard.test.ts | test | mutation guard, cancellation, modes and locking |
| auth.test.ts | test | shared-secret token compare and generation |
| bg-held-sessions.test.ts | test | per-session background hold registry |
| config-generator.test.ts | test | shared and scoped MCP config builders |
| debug-mode.test.ts | test | debug gate, thresholds, large-tool warnings |
| gateway-generator.test.ts | test | model discovery parsing and gateway yaml |
| i18n.test.ts | test | locale lookup, fallback, and table parity |
| paths.test.ts | test | install, data, project, and workspace paths |
| profile-generator.test.ts | test | profile generation and default choices |
| resilient-watch.test.ts | test | watcher failure, registration race, and cleanup |
| runtime-env.test.ts | test | excludes file-only metadata from runtime env |
| settings-initial-error.test.ts | test | first-read corruption fallback and recovery |
| settings-migration.test.ts | test | legacy env migration and isolated reset lifecycle |
| settings-watcher.test.ts | test | settings watcher ordering and polling fallback |
| settings.test.ts | test | settings registry, parsing, reload and writes |
| singleton-lock.test.ts | test | pidfile lock acquire, release, liveness |
| status-format.test.ts | test | thread status message formatting |
