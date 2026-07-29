Please update me when files in this folder change

Scheduling jobs: the concrete work performed when a schedule fires.

| filename | role | function |
|---|---|---|
| _shared.ts | util | Shared status and completion helpers for jobs |
| memory-index-regen.ts | job | Regenerates memory indexes on schedule |
| scheduled-task.ts | job | Runs a fired schedule as an agent thread |
| sync-public.ts | job | Pulls commits from the public repo |
| target-dispatch.ts | core | Decides how a fired schedule is landed |
| task-archive.ts | job | Archives completed tasks on schedule |
| task-dispatch.ts | job | Claims tasks, starts threads, and quarantines failures |
