Please update me when files in this folder change

Agent abstraction layer decoupling Cortex core from the Claude and PI backend CLIs.
Defines the shared adapter contract, the capability matrix, and the normalized event schema.

| filename | role | function |
|---|---|---|
| index.ts | entry | selects the adapter for a backend |
| types.ts | types | adapter, process, supervision and continuation contracts |
| capabilities.ts | core | declares ten capabilities for each backend |
| bg-wait.ts | core | resolves and awaits background continuations |
| event-tee.ts | core | fans out run events and enforces required sinks |
| claude/ | subdir | Claude Code backend adapter |
| normalize/ | subdir | backend-neutral event and tool schema |
| pi/ | subdir | PI backend adapter |
