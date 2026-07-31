Please update me when files in this folder change

Business-logic layer of the agent server: one subdirectory per capability, built on core, store and events,
and consumed by orchestration and the platform surfaces.

| filename | role | function |
|---|---|---|
| agent-run/ | subdir | One-shot identity, trajectories and containment |
| agents/ | subdir | Backend, model and profile selection per channel |
| costs/ | subdir | Spend tracking, budgets and rate-limit throttle |
| executions/ | subdir | Lifecycle and live output of dispatched runs |
| hooks/ | subdir | Derived view of hook declarations for the UI |
| mcp/ | subdir | MCP servers exposing Cortex tools to agents |
| memory/ | subdir | Knowledge indexes and session context sources |
| monitor/ | subdir | Host resource watch and system notices |
| projects/ | subdir | Registry of projects that scope all work |
| remote/ | subdir | Links to cortex-client daemons on devices |
| scheduling/ | subdir | Recurring and one-off scheduled task runs |
| sessions/ | subdir | Session records, registry, backup and hooks |
| system/ | subdir | Update checks, install and health diagnostics |
| tasks/ | subdir | Task queue, dispatch, archive and task CLIs |
| threads/ | subdir | Thread lifecycle, templates and thread trees |
| tui-session/ | subdir | Session service for the terminal UI |
| ui-service/ | subdir | Query, mutate and subscribe facade for the UI |
