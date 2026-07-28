Please update me when files in this folder change

Agent abstraction layer decoupling Cortex core from the Claude, Codex, and PI backend CLIs.
Defines the shared adapter contract, the capability matrix, and the normalized event schema.

| filename | role | function |
|---|---|---|
| index.ts | entry | selects the adapter for a backend |
| types.ts | types | adapter, process, and sink contracts |
| capabilities.ts | core | declares what each backend supports |
| bg-wait.ts | core | waits for background work on a turn |
| claude/ | subdir | Claude Code backend adapter |
| codex/ | subdir | Codex backend adapter |
| normalize/ | subdir | backend-neutral event and tool schema |
| pi/ | subdir | PI backend adapter |
