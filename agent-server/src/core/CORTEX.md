Please update me when files in this folder change

Layer-0 foundation of the agent server: depends on nothing above it and is imported by every other layer.
Owns paths, version, logging, auth, i18n, JSON persistence, task parsing, config generation, live-run state,
and the vocabulary both the adapter and the domain speak (agent roles, the subagent contract, tool names,
Codex quota, attachment mimetypes, the prompt template engine).

| filename | role | function |
|---|---|---|
| agents/ | subdir | role table and the backend-neutral subagent contract |
| anthropic-models.ts | data | defines the Anthropic model ids the gateway and subagent catalog share |
| async-mutex.ts | util | serializes concurrent async operations |
| atomic-write.ts | util | Serializes cancellable atomic file replacements |
| auth.ts | core | Issues, captures, scrubs and checks shared-secret auth tokens |
| calver.ts | util | compares CalVer YYYY.M.D[-N] versions |
| cli-utils.ts | util | formats CLI help/errors and reads stdin as text or raw bytes |
| codex-quota.ts | parser | Parses Codex quota headers, labels, and the notice wire form |
| config-generator.ts | config | generates bundled and gated MCP configs |
| debug-mode.ts | config | reports DEBUG state and tool size limits |
| gateway-generator.ts | config | scans PI models through the bundled SDK and builds bounded gateway.yaml |
| hook-bus.ts | core | dispatches hooks with safe arguments and diagnostics |
| hook-exec.ts | util | runs hooks and captures bounded output and exit status |
| i18n.ts | core | resolves localized messages by key |
| icons.ts | data | provides the semantic icon character set |
| json-repository.ts | core | reads and writes cached JSON stores |
| locales/ | subdir | English and Chinese message tables |
| log.ts | core | creates loggers with process-scoped console and file policy |
| loopback-http.ts | transport | Runs bounded MCP-to-daemon JSON requests |
| mcp-bundles.ts | policy | defines validated built-in MCP compositions |
| mcp-timeout.ts | config | Defines the shared MCP infrastructure deadline |
| mcp-tool-gate.ts | policy | canonicalizes and enforces MCP tool allowlists, incl. the commission- and subagent-tool gates |
| media-types.ts | data | Classifies attachment mimetypes as image, video or other |
| native-name.ts | util | Build safe native plugin names |
| paths.ts | config | defines install, data, config paths and the single agent-cwd resolver |
| pi-sdk.ts | boundary | lazily imports the bundled PI SDK once (with a boot prewarm), locates its CLI entry and PI's user agent dir |
| pi-session-filename.ts | util | parses and selects PI transcript filenames |
| platform-settings-spec.ts | contract | Validates platform credential patches and snapshots |
| production-benchmark-evidence.ts | guard | Validates immutable benchmark admission facts, including the attested context a daemon-created root adopts |
| profile-generator.ts | config | generates the agent profiles file |
| prompt-template.ts | util | renders the `{{var}}` / `{{#if}}` prompt mini-template and resolves system vars |
| resilient-watch.ts | util | falls back from filesystem watchers to polling |
| resume-reminder.ts | data | continuation prompt for interrupted work |
| run-registry.ts | state | the one index of live runs and background holds; answers sessionState; owns the two hold verbs (supersedeHolds vs stopHolds) so taking a session over never ends work that is still running; carries the live AgentRun for mid-turn injection lookup and the per-channel streaming callback slot |
| runtime-env.ts | config | excludes file-only metadata from runtime env |
| session-todos.ts | state | holds each session's latest agent task list |
| settings-migration.ts | config | safely migrates legacy env settings at startup |
| settings-spec.ts | contract | Defines runtime settings including Web Feishu skills |
| settings.ts | config | reloads settings and applies provider/window policy patches |
| singleton-lock.ts | util | creates, claims and releases a process pidfile |
| status-format.ts | util | formats status and progress messages; renderTurnStatus is the one place every turn-outcome line is written |
| task-node.ts | util | locates and creates task node artifacts |
| task-parser.ts | core | Reads task schema, generations, filters and YAML |
| tool-names.ts | core | maps canonical names to backend-native tools |
| types/ | subdir | shared agent and thread type definitions |
| utils.ts | util | re-exports paths plus time, text and npm-prefix helpers |
| version.ts | config | exposes the Cortex version and docs URL |
