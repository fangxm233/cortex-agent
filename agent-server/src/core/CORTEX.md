Please update me when files in this folder change

Dependency-light primitives shared by every server layer.

| filename | role | function |
|---|---|---|
| async-mutex.ts | utility | Serializes asynchronous critical sections |
| atomic-write.ts | utility | Writes files atomically |
| auth.ts | security | Authenticates client and webhook requests |
| bg-held-sessions.ts | registry | Tracks background-held web sessions |
| cli-utils.ts | utility | Formats command-line help and errors |
| config-generator.ts | config | Generates MCP and runtime configuration |
| debug-mode.ts | config | Reads process-wide debug settings |
| gateway-generator.ts | config | Generates gateway configuration |
| i18n.ts | i18n | Formats localized user-facing messages |
| icons.ts | constants | Defines shared interface icons |
| json-repository.ts | store | Provides mutexed JSON persistence |
| log.ts | logging | Creates scoped runtime loggers |
| paths.ts | paths | Defines canonical filesystem paths |
| profile-generator.ts | config | Generates profile configuration |
| running-executions.ts | registry | Tracks active execution processes |
| singleton-lock.ts | lock | Guards singleton server processes |
| status-format.ts | format | Formats execution and thread status |
| task-node.ts | paths | Builds task artifact and ledger paths |
| task-parser.ts | parser | Parses task queue documents |
| utils.ts | utility | Provides shared server helpers |
| version.ts | constants | Defines the server package version |
| locales/ | directory | Contains locales modules |
| types/ | directory | Contains types modules |
