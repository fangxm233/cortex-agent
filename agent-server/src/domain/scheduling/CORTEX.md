Please update me when files in this folder change

Scheduling domain: runs recurring and one-off tasks when they come due.
Covers schedule storage and firing, the job dispatch table, and user-facing schedule management.

| filename | role | function |
|---|---|---|
| job-registry.ts | core | Registers job runners and dispatches by key |
| runner.ts | entry | Wires job modules and creates the scheduler |
| schedule-cli.ts | cli | Manages schedules from the terminal |
| schedule-command.ts | command | Handles the !schedule chat command |
| scheduler.ts | core | Tracks schedules and fires them when due |
| jobs/ | subdir | Job runners invoked when a schedule fires |
