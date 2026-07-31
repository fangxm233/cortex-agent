Please update me when files in this folder change

Layer-0 foundation of the agent server: depends on nothing above it and is imported by every other layer.
Owns paths, version, logging, auth, i18n, JSON persistence, task parsing, config generation, and live-run state.

| filename | role | function |
|---|---|---|
| async-mutex.ts | util | serializes concurrent async operations |
| atomic-write.ts | util | writes atomically with optional permission mode |
| auth.ts | core | issues and checks shared-secret auth tokens |
| bg-held-sessions.ts | state | tracks sessions held running in background |
| calver.ts | util | compares CalVer YYYY.M.D[-N] versions |
| cli-utils.ts | util | formats CLI help and errors, reads stdin |
| config-generator.ts | config | generates shared and scoped MCP config files |
| debug-mode.ts | config | reports DEBUG state and tool size limits |
| gateway-generator.ts | config | discovers models and builds gateway.yaml |
| hook-bus.ts | core | dispatches hooks with safe arguments and diagnostics |
| hook-exec.ts | util | runs hooks and captures bounded output and exit status |
| i18n.ts | core | resolves localized messages by key |
| icons.ts | data | provides the semantic icon character set |
| json-repository.ts | core | reads and writes cached JSON stores |
| log.ts | core | creates console and rotating file loggers |
| paths.ts | config | defines install, data, and config paths |
| profile-generator.ts | config | generates the agent profiles file |
| running-executions.ts | state | registers and kills live agent executions |
| settings-migration.ts | config | safely migrates legacy env settings at startup |
| settings-spec.ts | config | defines browser-safe settings metadata and parsers |
| settings.ts | config | validates settings values, sources and hot reloads |
| singleton-lock.ts | util | claims and releases a process pidfile |
| status-format.ts | util | formats status and progress messages |
| task-node.ts | util | locates and creates task node artifacts |
| task-parser.ts | core | reads, filters, and writes TASKS.yaml |
| utils.ts | util | re-exports paths plus time and text helpers |
| version.ts | config | exposes the Cortex version and docs URL |
| locales/ | subdir | English and Chinese message tables |
| types/ | subdir | shared agent and thread type definitions |
