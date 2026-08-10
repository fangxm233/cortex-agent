一旦此文件夹有文件变化，请更新我

Benchmark policy boundary validates declared arms and freezes all resolved trial inputs.

| filename | role | function |
|---|---|---|
| accounting-reconciliation.ts | 核心 | Reconciles benchmark usage accounting |
| actor-capability-scope.ts | 核心 | Registers actor capabilities |
| arm-schema.ts | 类型 | Validates benchmark arm definitions |
| attempt-record.ts | 类型 | Defines benchmark attempt records |
| capabilities.ts | 策略 | Defines benchmark capability grants |
| composite-runtime-ports.ts | 类型 | Defines composite runtime ports |
| trial-task-mutator.ts | 核心 | Applies capability-fenced task mutations |
| trial-task-ports.ts | 核心 | Provides trial task state ports |
| composite-manifest.ts | 核心 | Builds composite trial manifests |
| decimal-text.ts | 工具 | Parses exact decimal values |
| lease-echo.ts | 核心 | Delivers workspace lease state |
| policy-backed-runtime-deps.ts | 策略 | Resolves frozen runtime dependencies |
| policy-compiler.ts | 核心 | Compiles benchmark trial policy |
| proposal-seal.ts | 核心 | Stores and seals task proposals |
| resolved-policy.ts | 类型 | Defines resolved trial policy |
| settings-snapshot.ts | 类型 | Captures immutable trial settings |
| task-broker-arguments.ts | 核心 | Validates broker request arguments |
| task-broker.ts | 核心 | Authorizes benchmark task actions |
| trial-acceptance-ledger.ts | 核心 | Records trial acceptance verdicts |
| terminal-predicate.ts | 核心 | Evaluates trial terminal state |
| trial-task-dispatcher.ts | 核心 | Selects and claims trial tasks |
| trial-clock.ts | 类型 | Provides deterministic trial time |
| trial-adapter-factory.ts | 核心 | Creates credential-pinned admitted adapters |
| trial-thread-adapter.ts | 核心 | Admits trial thread adapter steps |
| variant-proposal.ts | 核心 | Classifies variant proposals |
| workspace-lease.ts | 核心 | Confines physical workspace write ownership |
