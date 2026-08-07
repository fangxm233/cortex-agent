Please update me when files in this folder change

Scheduling domain: runs recurring and one-off tasks when they come due.
Covers schedule storage and firing, the job dispatch table, and user-facing schedule management.

| filename | role | function |
|---|---|---|
| builtin-job-controller.ts | core | Runs settings-backed periodic job timers |
| builtin-job-migration.ts | startup | Migrates legacy programmatic schedules |
| builtin-jobs.ts | entry | Composes daemon-owned infrastructure jobs |
| job-registry.ts | core | Registers job runners and dispatches by key |
| runner.ts | entry | Wires scheduled jobs and creates the scheduler |
| schedule-cli.ts | cli | Manages schedules from the terminal |
| schedule-command.ts | command | Handles the !schedule chat command |
| scheduler.ts | core | Fires schedules and emits lifecycle hooks |
| jobs/ | subdir | Job runners invoked when a schedule fires |
