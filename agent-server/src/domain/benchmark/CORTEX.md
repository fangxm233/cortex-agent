一旦此文件夹有文件变化，请更新我

Benchmark policy boundary validates declared arms and freezes all resolved trial inputs.

| filename | role | function |
|---|---|---|
| accounting-reconciliation.ts | 核心 | Records proxy-side and journal-side usage figures side by side |
| actor-capability-scope.ts | 核心 | Registers actor capabilities |
| arm-schema.ts | 类型 | Validates benchmark arm definitions and declared limits |
| attempt-record.ts | 类型 | Defines v2 attempts, token ranges and durable edges |
| capabilities.ts | 策略 | Defines benchmark capability grants |
| composite-runtime-ports.ts | 类型 | Defines composite runtime ports |
| trial-task-mutator.ts | 核心 | Applies capability-fenced task mutations |
| trial-task-ports.ts | 核心 | Provides trial task state ports |
| composite-manifest.ts | 核心 | Validates composite v2 identity and usage |
| decimal-text.ts | 工具 | Parses exact decimal values |
| lease-echo.ts | 核心 | Delivers workspace lease state |
| policy-backed-runtime-deps.ts | 策略 | Resolves frozen runtime dependencies |
| policy-compiler.ts | 核心 | Compiles benchmark trial policy from declared arm limits |
| production-evidence-export.ts | 核心 | Atomically publishes production evidence v2 |
| production-evidence-journal.ts | 核心 | Verifies production journals for projection |
| production-evidence-projection.ts | 核心 | Validates launcher input and projects v2 bytes |
| production-evidence-topology.ts | 核心 | Validates durable production attempt topology |
| proposal-seal.ts | 核心 | Stores and seals task proposals |
| resolved-policy.ts | 类型 | Defines resolved trial policy |
| settings-snapshot.ts | 类型 | Captures immutable trial settings |
| task-broker-arguments.ts | 核心 | Validates broker request arguments |
| task-broker.ts | 核心 | Authorizes benchmark task actions |
| trial-acceptance-ledger.ts | 核心 | Records trial acceptance verdicts |
| trial-manager-qa.ts | 核心 | Routes durable trial-local manager questions |
| terminal-predicate.ts | 核心 | Evaluates trial structure and terminal state |
| trial-task-dispatcher.ts | 核心 | Selects and claims trial tasks |
| trial-task-tree-coordinator.ts | 核心 | Owns standalone manager task-tree lifecycle |
| trial-clock.ts | 类型 | Provides deterministic trial time |
| trial-adapter-factory.ts | 核心 | Creates credential-pinned admitted adapters |
| trial-thread-adapter.ts | 核心 | Admits trial thread adapter steps |
| variant-proposal.ts | 核心 | Classifies bounded variant verdicts |
| workspace-lease.ts | 核心 | Confines physical workspace write ownership |
