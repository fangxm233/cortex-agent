Please update me when files in this folder change

Cortex runtime server: Slack bot + LLM scheduling + scheduled tasks + webhook.
Source code in src/, configuration/data in root directory, logs in logs/.

| filename | role | function |
|---|---|---|
| `src/` | Source code | Production TS source code and task-system CLI |
| `tests/` | Tests | vitest regression tests (`vitest.config.ts`; run via `npm test` → `scripts/run-tests.sh`) |
| `package.json` | Configuration | npm dependencies + bins: `cortex` (`dist/entry/cli.js`), `cortex-run` (`dist/domain/tasks/system/cortex-run.js`), `cortex-task` (`dist/domain/tasks/system/task-cli.js`). Upgrade: `npm run build && npm pack && npm install -g ./cortex-agent-server-X.Y.Z.tgz` |
| `.env` | Configuration | Slack and other sensitive configuration (gitignored) |
| `mcp-config.json` | Configuration | Claude CLI MCP server entry point |
| `mode.json` | Configuration | Current runtime mode and profile |
| `profiles.json` | Configuration | Named agent profile list |
| `budget.json` | Configuration | Daily/monthly budget limit |
| `costs.jsonl` | Data | Cost record per call (90-day rolling, JSONL format) |
| `schedules.json` | Data | Scheduled tasks plus provider/window rate-limit throttle state and the global resume queue |
| `update-state.json` | Data | Skipped-version persistence for server auto-update (DR-0013) |
| `orient-state.json` | Data | Old compound hierarchical state (legacy) |
| `pending-tasks.json` | Data | Pending task tracking (gitignored) |
| `executions.json` | Data | Unified execution registry |
| `channel-registry.json` | Data | Project to Slack channel mapping |
| `project-dirs.json` | Data | Project to machine external code directory mapping |
| `config/thread-templates/` | Configuration | Thread agent definitions, orchestration templates, and shell definitions — directory form, one JSON file per entity under `agents/`, `templates/`, `shells/` (DR-0017 D6 Phase 2.5; legacy single `thread-templates.json` auto-migrated on startup) |
| `session-hooks.json` | Configuration | session-level hook configuration (gitignored; template at `session-hooks.example.json`) |
| `session-hooks.example.json` | Configuration | Copyable example of session-hooks.json (committed) |
| `threads.json` | Data | Active and historical Thread state (gitignored) |
| `sessions.json` | Data | channel -> Claude/Codex session |
| `session-registry.json` | Data | cortex-XXXX short name mapping |
| `conversation-ledger.json` | Data | Turn sequence and message edit rollback (gitignored) |
| `data/pending-injections.json` | Data | Durable active records for unconsumed mid-turn messages |
| `data/pi/` | Data | PI private configuration directory (PI_CODING_AGENT_DIR points here; contains auto-generated models.json) |
| `logs/` | Directory | Daemon + raw/txt LLM logs |
| `tasks/` | Directory | Reserved |
| `tmp/` | Directory | Legacy temporary files (gitignored) |
