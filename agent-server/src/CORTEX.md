Please update me when files in this folder change

Production source of the agent server, layered from core utilities up through store, events, domain,
orchestration, to the process entry points.

| filename | role | function |
|---|---|---|
| agent-adapter/ | subdir | Backend adapters for Claude, Codex and PI |
| core/ | subdir | Zero-dependency utilities, paths and types |
| domain/ | subdir | Business logic of every server capability |
| entry/ | subdir | Process and command-line entry points |
| events/ | subdir | Typed event bus and event log |
| orchestration/ | subdir | Turn routing, agent runs and commands |
| platform/ | subdir | Slack, Feishu, TUI and HTTP surfaces |
| store/ | subdir | File-backed repositories with atomic writes |
| tui/ | subdir | Full-screen terminal chat client |
