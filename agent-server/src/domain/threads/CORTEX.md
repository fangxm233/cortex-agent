Please update me when files in this folder change

Thread domain layer — owns thread lifecycle, templates, prompts, step execution, and thread trees.
Consumed by the orchestration and UI layers through the index barrel.

| filename | role | function |
|---|---|---|
| index.ts | entry | re-exports the core thread modules |
| utils.ts | util | thread id, target, and stage name helpers |
| artifact-io.ts | io | reads thread artifacts and modified file paths |
| template-loader.ts | config | loads and hot-reloads thread template config |
| template-resolver.ts | config | expands vars and blocks in prompt templates |
| shell-templates.ts | config | turns a shell binding into a full template |
| prompt-builder.ts | build | assembles prompts and agent control policy |
| state-machine.ts | state | Drives lifecycle and task artifact placement |
| runner.ts | runtime | Runs steps through scoped local or daemon dependencies |
| local-runtime-deps.ts | runtime | Injects daemon-free stores, resolvers and ledgers |
| hook-runner.ts | hook | Adapts lifecycle hooks to HookBus and hook agents |
| thread-transcript.ts | record | records each step's conversation to history |
| tree.ts | tree | tracks thread trees and spawn resource guards |
| contract.ts | contract | builds delegation contracts and goal chains |
| auto-thread.ts | util | decides auto compound and merges final outputs |
