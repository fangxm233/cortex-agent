Please update me when files in this folder change

Layer-0 foundation of the agent server: depends on nothing above it and is imported by every other layer.
Owns paths, version, logging, auth, i18n, JSON persistence, task parsing, config generation, and live-run state.

| filename | role | function |
|---|---|---|
| async-mutex.ts | util | serializes concurrent async operations |
| atomic-write.ts | util | Serializes cancellable atomic file replacements |
| auth.ts | core | Issues, captures, scrubs and checks shared-secret auth tokens |
| bg-held-sessions.ts | state | tracks sessions held running in background |
| session-todos.ts | state | holds each session's latest agent task list |
| calver.ts | util | compares CalVer YYYY.M.D[-N] versions |
| cli-utils.ts | util | formats CLI help/errors and reads stdin as text or raw bytes |
| config-generator.ts | config | generates bundled and gated MCP configs |
| debug-mode.ts | config | reports DEBUG state and tool size limits |
| gateway-generator.ts | config | discovers models and builds bounded gateway.yaml |
| hook-bus.ts | core | dispatches hooks with safe arguments and diagnostics |
| hook-exec.ts | util | runs hooks and captures bounded output and exit status |
| i18n.ts | core | resolves localized messages by key |
| icons.ts | data | provides the semantic icon character set |
| json-repository.ts | core | reads and writes cached JSON stores |
| log.ts | core | creates loggers with process-scoped console and file policy |
| loopback-http.ts | transport | Runs bounded MCP-to-daemon JSON requests |
| mcp-bundles.ts | policy | defines validated built-in MCP compositions |
| mcp-timeout.ts | config | Defines the shared MCP infrastructure deadline |
| mcp-tool-gate.ts | policy | canonicalizes and enforces MCP tool allowlists, and the plan-tool variant |
| paths.ts | config | defines install, data, and config paths |
| pi-session-filename.ts | util | parses and selects PI transcript filenames |
| profile-generator.ts | config | generates the agent profiles file |
| production-benchmark-evidence.ts | guard | Validates immutable benchmark admission facts, including the attested context a daemon-created root adopts |
| resilient-watch.ts | util | falls back from filesystem watchers to polling |
| resume-reminder.ts | data | continuation prompt for interrupted work |
| runtime-env.ts | config | excludes file-only metadata from runtime env |
| running-executions.ts | state | indexes live executions and generic dialog processes |
| settings-migration.ts | config | safely migrates legacy env settings at startup |
| settings-spec.ts | config | defines settings, exact window policy shapes, and job defaults |
| settings.ts | config | reloads settings and applies provider/window policy patches |
| singleton-lock.ts | util | creates, claims and releases a process pidfile |
| status-format.ts | util | formats status and progress messages |
| task-node.ts | util | locates and creates task node artifacts |
| task-parser.ts | core | Reads task schema, generations, filters and YAML |
| utils.ts | util | re-exports paths plus time, text and npm-prefix helpers |
| version.ts | config | exposes the Cortex version and docs URL |
| locales/ | subdir | English and Chinese message tables |
| types/ | subdir | shared agent and thread type definitions |
