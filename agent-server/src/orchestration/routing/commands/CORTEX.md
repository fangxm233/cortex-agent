# orch/routing/commands/ — !Command dispatcher

Per-command-family handler files split from `command-handlers.ts` ([S10-B]). Each file is ≤200 LoC and handles one family of `!` Slack commands.

| File | Commands | Dependency |
|------|----------|------------|
| `index.ts` | `registerCommands` exact/prefix dispatcher, including exact `!compact` | All below |
| `orient.ts` | `!orient` | None (placeholder) |
| `restart.ts` | `!restart` | `core/utils` (STORE_DIR), `core/singleton-lock` (isProcessAlive) — touches the daemon's `.restart` trigger to respawn app.ts; no-ops with a notice when no live daemon. `triggerServerRestart(deps)` is the injectable, unit-tested core |
| `lang.ts` | `!lang` | `core/i18n` (setLocale), `domain/system/preferences` (setLang) — show/switch UI language, persist + live switch |
| `thread.ts` | `!thread` | Re-exports from `command-thread-handlers.ts` |
| `schedule.ts` | `!schedule` | Re-exports from `schedule-command.ts` (needs scheduler dep) |
| `cost.ts` | `!cost`, `!budget` | `cost-tracker` |
| `task.ts` | `!tasks` | `task-parser` |
| `mode.ts` | `!mode`, `!backend`, `!model`, `!profile`, `!skills`, `!agent` | `mode-manager`, `profile-manager`, `skill-scanner` |
| `status.ts` | `!status`, `!help` including compact help | status report dep |
| `compact.ts` | `!compact` | injected channel compact coordinator |
| `cancel.ts` | `!cancel` | `running-executions`, `conduit-queue`; needs `cancelDispatchedTask` dep. Exports `cancelChannelRuns(channel)` — the shared no-arg/`--all` channel-cancel path, also wired into ui-service `sessions.cancel` (Web UI Stop) via the `cancelSessionRun` dep in entry/app.ts |
| `nvtop.ts` | `!nvidia-smi`, `!nvtop` | `gpu-monitor`, `dispatch-utils`, `client-manager` |
| `session.ts` | `!new`, `!newq`, `!resume` | `claude-bridge`, `session-registry-repo`, `conversation-ledger`, `domain/sessions/session-hooks` |
| `channel.ts` | `!projects`, `!register`, `!unregister`, `!project-dir` | `channel-repo`, `project-dir-repo` |
| `device.ts` | `!devices`, `!clients` | `client-manager`, `dispatch-utils` |
| `tail.ts` | `!tail` | `fs` (daemon.log tail) |
| `sendfile.ts` | `!sendFile` | `dispatch-utils`, `scp` |

Each handler signature: `(channel: string, adapter: PlatformAdapter, trimmedMessage: string) => Promise<void>`.
Handlers needing injected deps use a `createXxxHandler(deps)` factory in index.ts.
