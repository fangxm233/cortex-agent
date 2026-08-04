Please update me when files in this folder change

Write side of the UI service — one handler module per domain area the UI is allowed to change.

| filename | role | function |
|---|---|---|
| sessions.ts | mutate | creates, sends to, and controls sessions |
| approvals.ts | mutate | approves, rejects, and queues approvals |
| auth.ts | mutate | Controls Web login flows and account logout |
| issues.ts | mutate | handles or deletes project issue entries |
| notes.ts | mutate | edits and completes private project notes |
| config.ts | mutate | writes budget, default profile and runtime settings |
| profiles.ts | mutate | creates, edits and removes profiles.json entries |
| hooks.ts | mutate | creates, edits, toggles, removes and tests hooks |
| schedules.ts | mutate | adds, updates, pauses, resumes, removes schedules |
| tasks.ts | mutate | claims, completes, and blocks tasks |
| threads.ts | mutate | cancels a running thread |
| executions.ts | mutate | cancels a running execution |
| projects.ts | mutate | creates a project |
| system.ts | mutate | restarts the agent server process and clears rate limits early |
