# projects/ Index

One subdirectory per active project.

## Project List

| Project | Status | Description |
|---------|--------|-------------|
<!-- Add entry here after adding a new project -->

## Standard Files Per Project

| File | Type | Purpose |
|------|------|---------|
| `STATUS.md` | Overwrite | Present-tense state register: overwritten when the project situation changes (hard cap 80 lines AND 6KB; see rules/status-md.md) |
| `ISSUES.md` | Append | Record issues affecting work efficiency |
| `experiments/` | Atomic file | One `.md` file per experiment (YAML frontmatter + body), `index.md` auto-generated |
| `knowledge/` | Atomic file | One `.md` file per knowledge entry, `index.md` auto-generated |
| `patterns/` | Atomic file | Cross-experiment patterns, `index.md` auto-generated |
| `_meta/` | Auto | `access-log.jsonl`: hook auto-recorded Read/Grep access log |
| `decisions/` | Append | Project-level design decision records |
| `mission.md` | Stable | Goals and success conditions |
| `roadmap.md` | Stable | Roadmap and milestones |
