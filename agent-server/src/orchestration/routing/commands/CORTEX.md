Please update me when files in this folder change

Chat command layer of the agent server, exposing operator controls that run outside a normal agent turn.
Each file covers one command family, from sessions and threads to devices, costs, schedules and files.

| filename | role | function |
|---|---|---|
| cancel.ts | command | stops running executions in a channel |
| channel.ts | command | manages project registration for channels |
| command-context.ts | types | shapes of command input and output |
| compact.ts | command | compacts the current session context |
| cost.ts | command | reports spending and sets budgets |
| device.ts | command | lists known and online client devices |
| dispatch.ts | command | overrides the profile of a dispatch thread |
| index.ts | entry | matches command text and dispatches handlers |
| lang.ts | command | shows and switches the interface language |
| login.ts | command | Drives validated auth prompts and replaceable notices |
| mode.ts | command | switches Claude/PI backend, model, profile and agent |
| nvtop.ts | command | reports GPU usage on registered machines |
| orient.ts | command | replies that the feature is not implemented |
| restart.ts | command | asks the daemon to restart the server |
| schedule.ts | command | lists and manages scheduled tasks |
| sendfile.ts | command | sends a local or remote file to the chat |
| session.ts | command | starts, resets and resumes sessions |
| status.ts | command | shows execution status and command help |
| tail.ts | command | streams the daemon log into the chat |
| task.ts | command | lists project tasks by filter |
| thread-handlers.ts | handlers | thread status, list, agents and cancel |
| thread.ts | util | re-exports the thread command handler |
