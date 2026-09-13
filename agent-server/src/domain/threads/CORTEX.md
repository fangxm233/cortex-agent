Please update me when files in this folder change

Thread domain layer — owns thread lifecycle, templates, prompts, step execution, and thread trees.
Step and hook-agent turns are built into `RunRequest`s and run through `startRun` (plan D8).
Consumed by the orchestration and UI layers through the index barrel.

| filename | role | function |
|---|---|---|
| index.ts | entry | re-exports the core thread modules |
| utils.ts | util | thread id, target, and stage name helpers |
| artifact-io.ts | io | reads artifacts through scoped thread state |
| template-loader.ts | config | reloads thread config and tracks its revision |
| template-resolver.ts | config | expands vars and blocks in prompt templates |
| shell-templates.ts | config | turns a shell binding into a full template |
| template-validate.ts | config | validates templates, agents, shells and tool gates |
| template-validate.parity.ts | guard | pins the validator schemas to the thread types |
| template-writer.ts | config | creates, replaces and deletes template config files |
| prompt-builder.ts | build | assembles thread step prompts (composition itself is domain/runs/prompt.ts) and resolves canonical tool gates |
| pending-user-inputs.ts | state | gates asynchronous buffered-input preparation |
| evidence-context.ts | guard | inherits immutable benchmark evidence from parents |
| state-machine.ts | state | drives lifecycle and inherits benchmark evidence |
| runner.ts | runtime | Builds each step's RunRequest/observers and runs it through startRun |
| hook-runner.ts | hook | Adapts lifecycle hooks to HookBus; hook agents run through startRun |
| thread-transcript.ts | record | Records tool devices, step rows and prompts |
| tree.ts | tree | resolves ancestry and tracks spawn facts and guards |
| contract.ts | contract | builds delegation contracts and goal chains |
| auto-thread.ts | util | decides auto compound and merges final outputs |
