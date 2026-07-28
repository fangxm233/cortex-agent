Please update me when files in this folder change

Write side of the UI service — one handler module per domain area the UI is allowed to change.

| filename | role | function |
|---|---|---|
| sessions.ts | mutate | creates, sends to, and controls sessions |
| approvals.ts | mutate | approves, rejects, and queues approvals |
| issues.ts | mutate | handles or deletes project issue entries |
| config.ts | mutate | writes budget and default profile settings |
| schedules.ts | mutate | adds, pauses, resumes, and removes schedules |
| tasks.ts | mutate | claims, completes, and blocks tasks |
| threads.ts | mutate | cancels a running thread |
| executions.ts | mutate | cancels a running execution |
| projects.ts | mutate | creates a project |
| system.ts | mutate | restarts the agent server process |
