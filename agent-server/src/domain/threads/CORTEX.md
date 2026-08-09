Please update me when files in this folder change

Thread domain layer — owns thread lifecycle, templates, prompts, step execution, and thread trees.
Consumed by the orchestration and UI layers through the index barrel.

| filename | role | function |
|---|---|---|
| index.ts | entry | re-exports the core thread modules |
| utils.ts | util | thread id, target, and stage name helpers |
| artifact-io.ts | io | reads artifacts through scoped thread state |
| template-loader.ts | config | merges, upgrades and reloads thread config |
| template-resolver.ts | config | expands vars and blocks in prompt templates |
| shell-templates.ts | config | turns a shell binding into a full template |
| template-validate.ts | config | reports what is broken in a template, agent or shell |
| template-validate.parity.ts | guard | pins the validator schemas to the thread types |
| template-writer.ts | config | creates, replaces and deletes template config files |
| prompt-builder.ts | build | assembles prompts from scoped runtime state |
| pending-user-inputs.ts | state | gates asynchronous buffered-input preparation |
| state-machine.ts | state | drives lifecycle against scoped thread state |
| runner.ts | runtime | Runs scoped steps after buffered inputs are ready |
| local-runtime-deps.ts | runtime | Declares the injected port bundle and fails closed off-scope |
| local-runtime-defaults.ts | runtime | Builds the daemon-side defaults for that bundle |
| local-runtime-scope.ts | runtime | Propagates local event policy across async callbacks |
| hook-runner.ts | hook | Adapts lifecycle hooks to HookBus and hook agents |
| thread-transcript.ts | record | records each step's conversation to history |
| tree.ts | tree | tracks thread trees and spawn resource guards |
| contract.ts | contract | builds delegation contracts and goal chains |
| auto-thread.ts | util | decides auto compound and merges final outputs |
