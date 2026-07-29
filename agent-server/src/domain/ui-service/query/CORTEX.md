Please update me when files in this folder change

Read side of the UI service — one handler module per domain area the UI displays.
Handlers return DTOs only and never change state.

| filename | role | function |
|---|---|---|
| sessions.ts | query | lists sessions and builds transcripts |
| threads.ts | query | Builds thread detail and optional artifact text |
| tasks.ts | query | maps task records and lists tasks |
| task-verification.ts | query | gathers done-when evidence for one task |
| executions.ts | query | lists and fetches dispatch executions |
| schedules.ts | query | lists scheduled tasks |
| projects.ts | query | lists projects and their conduits |
| memory.ts | query | browses and reads project memory files |
| approvals.ts | query | lists pending approval entries |
| issues.ts | query | lists a project's issue entries |
| cost.ts | query | reports the cost summary |
| config.ts | query | Returns redacted config and mounted hooks |
| machines.ts | query | lists machines with live connection state |
| skills.ts | query | lists available skill groups |
| thread-templates.ts | query | returns every thread template definition |
| system.ts | query | Reports throttle windows and waiting counts |
