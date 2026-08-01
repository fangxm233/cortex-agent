Please update me when files in this folder change

Agent abstraction layer decoupling Cortex core from the Claude and PI backend CLIs.
Defines the shared adapter contract, the capability matrix, and the normalized event schema.

| filename | role | function |
|---|---|---|
| index.ts | entry | selects adapters and pins PI transcript paths |
| types.ts | types | adapter, process and accounting contracts |
| capabilities.ts | core | declares ten capabilities for each backend |
| bg-wait.ts | core | merges continuation results and reported cost state |
| event-tee.ts | core | fans out run events and enforces required sinks |
| claude/ | subdir | Claude Code backend adapter |
| normalize/ | subdir | backend-neutral events, accounting and tool schema |
| pi/ | subdir | PI backend adapter |
