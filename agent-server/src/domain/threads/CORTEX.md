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
| prompt-builder.ts | build | assembles agent prompts and slot configs |
| state-machine.ts | state | drives thread lifecycle and control state |
| runner.ts | runtime | runs, suspends, and resumes thread steps |
| hook-runner.ts | hook | runs lifecycle hook scripts and hook agents |
| thread-transcript.ts | record | records each step's conversation to history |
| tree.ts | tree | tracks thread trees and spawn resource guards |
| contract.ts | contract | builds delegation contracts and goal chains |
| auto-thread.ts | util | decides auto compound and merges final outputs |
