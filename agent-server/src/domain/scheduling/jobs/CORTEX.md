Please update me when files in this folder change

Scheduling jobs: concrete runners used by persisted schedules and daemon-owned periodic jobs.

| filename | role | function |
|---|---|---|
| _shared.ts | util | Shared status and completion helpers for jobs |
| auth-expiry-scan.ts | job | Warns for in-use expired authentication states |
| memory-index-regen.ts | job | Regenerates memory indexes as a built-in job |
| scheduled-task.ts | job | Runs a fired schedule as an agent thread |
| sync-public.ts | job | Pulls commits from the public repo |
| target-dispatch.ts | core | Decides how a fired schedule is landed |
| task-archive.ts | job | Archives completed tasks as a built-in job |
| task-dispatch.ts | job | Reserves and starts generation-owned task dispatches |
