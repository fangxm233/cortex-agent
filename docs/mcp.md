# MCP — Model Context Protocol

Cortex ships privilege-scoped and platform-scoped MCP (Model Context Protocol)
servers that give agents access to remote machines, task monitoring, thread
control, scheduling, costs, and platform integrations. This document explains
what each server provides, how they are composed, and how to add third-party
MCP servers.

## What MCP is

MCP is an open protocol that lets LLM applications expose tools to agents
through a standardized JSON-RPC interface over stdio or HTTP. Cortex uses MCP
to bridge between the agent process (which has no direct access to
agent-server internals) and the server's capabilities. MCP support varies by
backend — see the feature matrix in [backends.md](./backends.md).

Claude Code reads MCP server configurations from a JSON file and spawns each
server as a child process. The agent can then call MCP tools just like
built-in tools (Bash, Read, Edit, etc.), with the tool names prefixed by
`mcp__<server-name>__`.

## Why Cortex ships its own MCP servers

Cortex's agent-server maintains state that the agent process cannot access
directly: WebSocket connections to remote machines, the schedule database,
cost records, the Slack API client, and execution registry. MCP servers serve
as a controlled bridge — the agent calls an MCP tool, the MCP server talks to
agent-server internals (via HTTP to the local webhook server on port 3001, or
by reading shared files), and the result flows back to the agent.

## The bundled MCP servers

### cortex-core

Exposes remote-machine operations and the read-only clock. It is loaded in all
sessions. Keeping the `cortex-core` server name preserves the canonical
`mcp__cortex-core__remote_*` names used by existing clients and skills.

| Tool | Parameters | Description |
|---|---|---|
| `remote_bash` | `device`, `command`, `timeout?`, `description?`, `run_in_background?` | Execute a shell command on a remote device via cortex-client |
| `remote_read` | `device`, `file_path`, `offset?`, `limit?` | Read a file from a remote device (supports images and PDFs) |
| `remote_write` | `device`, `file_path`, `content` | Write content to a file on a remote device |
| `remote_edit` | `device`, `file_path`, `old_string`, `new_string`, `replace_all?` | Edit a file on a remote device by string replacement |
| `remote_glob` | `device`, `pattern`, `path?` | Find files matching a glob pattern on a remote device |
| `remote_grep` | `device`, `pattern`, `path?`, `glob?`, `type?`, `output_mode?`, `-A?`, `-B?`, `-C?`, `-i?`, `-n?`, `head_limit?`, `offset?`, `multiline?` | Search file contents on a remote device using ripgrep |
| `current_time` | `timezone?` | Get the current date/time; optional IANA timezone (defaults to server local). Returns Unix epoch, UTC ISO, and localized wall-clock with offset |

The server implementation is at `agent-server/src/domain/mcp/core-server.ts`.

### cortex-tasks

Exposes read-only task monitoring and is loaded in all sessions.

| Tool | Parameters | Description |
|---|---|---|
| `task_status` | `task_id`, `project?` | Read a task's lifecycle state (status, actionable, claimed_by, blocked_by, deps, parent) |
| `task_result` | `task_id`, `project?` | Read a task's outcome (done/blocked, done_when, completion note, block reason) |
| `task_list` | `project?`, `status?`, `parent?`, `limit?` | List tasks (optionally by status or parent) |

The server implementation is at `agent-server/src/domain/mcp/tasks-server.ts`.

### cortex-thread

Exposes the thread lifecycle control plane and manager Q&A. It is loaded only
when `CORTEX_THREAD_ID` identifies an active thread; direct sessions never
receive these tools.

| Tool | Parameters | Description |
|---|---|---|
| `thread_abort` | `kind`, `diagnosis` | Escalate YOUR OWN thread when the task is too-big / mis-scoped / blocked-external (terminal `aborted`) |
| `thread_split` | `subtasks` | Decompose YOUR OWN task into children (keep-parent join) that flow through the dispatch queue |
| `thread_wait` | `on_tasks?`, `on_threads?` | Suspend YOUR OWN thread until awaited children finish; pair with `cortex-task spawn` |
| `ask_manager` | `question` | Ask the planning manager a blocking clarification question |
| `answer_subtask` | `question_id`, `answer` | Answer a clarification question from a child task |

The server implementation is at `agent-server/src/domain/mcp/thread-server.ts`.
Tool registrars remain in `agent-server/src/domain/mcp/tools/`.

### cortex-ext

Exposes Cortex management tools: scheduling, cost queries, and context
resolution. Claude loads it only for direct/user sessions; the PI bridge
retains its existing behavior of loading cortex-ext in all sessions.

| Tool | Parameters | Description |
|---|---|---|
| `cortex_schedule_add` | `type`, `message`, `interval?`, `time?`, `dayOfWeek?`, `delay?`, `target?`, `fallback?`, `profile?`, `preCheck?`, `channel?` | Create a scheduled task (interval, daily, weekly, or once) |
| `cortex_schedule_list` | `limit?` | List all scheduled tasks with their status |
| `cortex_schedule_get` | `id` | Look up a scheduled task by its 8-char hex ID |
| `cortex_schedule_remove` | `id` | Delete a scheduled task (idempotent) |
| `cortex_schedule_pause` | `id` | Pause a recurring scheduled task |
| `cortex_schedule_resume` | `id` | Resume a paused scheduled task |
| `cost_query` | _(none)_ | Query current cost: today/month spending, budget limits, remaining budget, API/plan split, source breakdown, token usage |
| `query_executions` | `execution_id?`, `task_id?`, `status?`, `project?`, `limit?` | Query execution records — filter by status, project, or look up by ID |
| `cortex_context` | _(none)_ | Return the current execution context: channel, sessionId, sessionName, threadId, profile, project, backend |

The server implementation is at `agent-server/src/domain/mcp/server.ts`.
Individual tools are in `agent-server/src/domain/mcp/tools/`.

### cortex-slack

Platform-specific MCP server for Slack. Loaded only when the session originates
from Slack, providing platform-specific file upload and messaging capabilities.

| Tool | Parameters | Description |
|---|---|---|
| `slack_send_file` | `file_path`, `file_name?`, `title?`, `comment?` | Upload a local file to Slack |

The server implementation is at `agent-server/src/domain/mcp/slack-server.ts`.

### cortex-feishu

Platform-specific MCP server for Feishu/Lark. Loaded only when the session
originates from Feishu. It exposes a single tool — sending files to a chat.

| Tool | Parameters | Description |
|---|---|---|
| `feishu_send_file` | `file_path`, `file_name?`, `title?`, `channel?` | Upload a local file to a Feishu chat |

Document, table, spreadsheet, and knowledge-base operations are **not** MCP
tools. They run through the official Lark/Feishu CLI (`@larksuite/cli`), driven
by the `feishu-doc` skill. The CLI handles native tables and block-level edits
reliably (the previous `feishu_docx_*` MCP tools degraded tables into text
blocks and were removed). See the `feishu-doc` skill for the install/auth
preflight and how to delegate to the CLI's embedded `lark-doc` / `lark-sheets`
/ `lark-base` skill guides.

The server implementation is at `agent-server/src/domain/mcp/feishu-server.ts`.
The tool is in `agent-server/src/domain/mcp/feishu/file.ts`.

### cortex-tui-bridge

Loaded for interactive TUI sessions and user-initiated Claude print sessions.
It replaces Claude Code's native `EnterPlanMode`, `ExitPlanMode`, and
`AskUserQuestion` tools with MCP equivalents routed through Cortex.

| Tool | Description |
|---|---|
| `cortex_plan_enter` | Emits a reminder that the agent is in plan mode |
| `cortex_plan_exit` | Reads the plan file, sends to Slack for human approval, blocks until resolved |
| `cortex_ask_user` | Asks 1–4 questions via Slack modal, blocks until answered |

The server implementation is at `agent-server/src/domain/mcp/tui-server.ts`.
Tools are in `agent-server/src/domain/mcp/tools/tui-plan.js` and `tui-ask.js`.

## MCP configuration files

Cortex auto-generates MCP config files at startup (via
`agent-server/src/core/config-generator.ts` and the `ensureMcpConfig()` call
in `agent-server/src/entry/startup-helpers.ts`). Platform-specific servers
(cortex-slack, cortex-feishu) are dynamically loaded based on the session's
origin platform.

| File | Loaded by | Servers |
|---|---|---|
| `~/.cortex/config/mcp-config.json` | Direct-session base | cortex-core + cortex-tasks + cortex-ext |
| `~/.cortex/config/mcp-config-core.json` | Thread-session layer | cortex-core only |
| `~/.cortex/config/mcp-config-tasks.json` | Thread-session layer | cortex-tasks only |
| `~/.cortex/config/mcp-config-thread.json` | Thread-session-only layer | cortex-thread only |
| `~/.cortex/config/mcp-config-tui.json` | Interaction layering (on-demand) | cortex-tui-bridge only |
| `~/.cortex/config/mcp-config-slack.json` | Slack-specific layering (on-demand) | cortex-slack |

Each file follows Claude Code's standard MCP config format:

```json
{
  "mcpServers": {
    "cortex-core": {
      "command": "node",
      "args": ["/path/to/core-server.js"],
      "cwd": "/path/to/cwd"
    },
    "cortex-tasks": {
      "command": "node",
      "args": ["/path/to/tasks-server.js"],
      "cwd": "/path/to/cwd"
    },
    "cortex-ext": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "cwd": "/path/to/cwd"
    }
  }
}
```

The config files are regenerated on every agent-server startup. Manual edits
to them will be overwritten. To customize MCP configuration, modify the
generator in `core/config-generator.ts` or the profile/budget/schedule settings
that the tools read.

### How the right config gets selected

In `agent-adapter/claude/spawn-args.ts`, MCP configs are composed from session
context:

- **Direct/user sessions** load `mcp-config.json` (core + tasks + ext), then add eligible platform and interaction layers. They never load `mcp-config-thread.json`.
- **Thread/template sessions** load `mcp-config-core.json`, `mcp-config-tasks.json`, and `mcp-config-thread.json`. They do not load direct-only ext, platform, or TUI-bridge layers.

The thread branch is marked by `session.cortexContext.useCoreMcp`. In the PI
bridge, core, tasks, and ext are always connected; `shouldLoadThreadControl()`
adds cortex-thread only when `CORTEX_THREAD_ID` is present. Platform-specific
servers remain gated by their source-channel predicates.

## How MCP tools communicate with agent-server

MCP servers run as separate child processes. They cannot directly access
agent-server in-process state (WebSocket connections, the schedule repo, the
execution registry). Instead, they communicate through two paths:

1. **HTTP loopback** — remote machine tools (`remote_bash`, `remote_read`,
   etc.) send HTTP POST to `http://127.0.0.1:3001/webhook/remote-command`.
   The webhook handler in `agent-server/src/orchestration/routing/webhook.ts`
   forwards the request to `client-manager.sendCommand()`, which sends it over
   WebSocket to the remote device.

2. **Shared file access** — schedule, cost, and execution tools read and write
   the shared data files in `~/.cortex/data/` (schedules.json, costs.jsonl,
   executions.json) directly, using the same repository layer as the main
   server process.

## Adding a third-party MCP server

To add a third-party MCP server (e.g., a database connector, a web search
tool, or a custom research tool), add it to `~/.cortex/config/mcp-config.json`.
If thread agents should also have it, add it to one of the thread-composed
config builders rather than the direct config only:

```json
{
  "mcpServers": {
    "cortex-core": { "command": "node", "args": ["..."], "cwd": "..." },
    "cortex-tasks": { "command": "node", "args": ["..."], "cwd": "..." },
    "cortex-ext": { "command": "node", "args": ["..."], "cwd": "..." },
    "my-custom-server": {
      "command": "python",
      "args": ["/home/user/my-mcp-server/server.py"],
      "env": { "API_KEY": "${MY_API_KEY}" }
    }
  }
}
```

**Important**: the config files are regenerated on every server restart. To
persist custom MCP server entries, modify the appropriate builder in
`agent-server/src/core/config-generator.ts` rather than editing generated JSON.

The type system already supports third-party MCP servers through the
`AgentSpawnConfig.mcpServers` field (per-backend `McpServerConfig` array), but
this field is not yet consumed by the adapters as of the current codebase. All
MCP configuration still flows through the `--mcp-config` CLI flag.

## Permission model

MCP tools cross the trust boundary from the agent process into agent-server
internals and remote machines. Cortex applies the following controls:

1. **Server-level availability** — MCP privileges are separated by server
   because backend tool allowlists do not filter individual MCP tools. Direct
   sessions never receive cortex-thread; thread sessions add it only when they
   carry thread context. Claude excludes ext from thread sessions, while PI
   retains its existing always-on ext behavior.

2. **Claude Code's third-party MCP is disabled** — the setting
   `ENABLE_CLAUDEAI_MCP_SERVERS: "false"` in `~/.cortex/.claude/settings.json`
   prevents Claude from auto-discovering MCP servers from its own directory.
   Cortex exclusively manages MCP servers through its own config files.

3. **Bypass permissions** — Claude Code is spawned with
   `--dangerously-skip-permissions --permission-mode bypassPermissions`,
   meaning it won't prompt for each MCP tool call. Access control happens at
   the MCP tool implementation level and through the PreToolUse hook system.

4. **PreToolUse guards** — the `tasks-yaml-guard.mjs` hook intercepts
   Edit/Write operations on `TASKS.yaml` files (including remote edits) and
   checks project locks. The `sensitive-file-edit.mjs` hook handles
   `.claude/` path protection.

5. **Network boundary** — MCP tools that talk to remote machines go through
   the client-manager's WebSocket layer. The `machines.json` registry
   controls which devices are known. Only devices with an active WebSocket
   connection can receive commands.

## Environment variables passed to MCP servers

The MCP server processes receive a subset of the agent server's environment:

| Variable | Source | Used by |
|---|---|---|
| `SLACK_CHANNEL` | Channel parameter at spawn time | cortex-ext (slack_send_file), tui-server |
| `SLACK_BOT_TOKEN` | process.env | cortex-ext |
| `CORTEX_SESSION_ID` | Session context | tui-server, context tools |
| `CORTEX_SESSION_NAME` | Session context | context tools |
| `CORTEX_THREAD_ID` | Thread context | cortex-thread tools, PI loading predicate, context tools |
| `CORTEX_PROFILE` | Session context | context tools |
| `CORTEX_PROJECT` | Session context | context tools |
| `CORTEX_EXECUTION_ID` | Execution context | task lock hooks |
| `CORTEX_TUI_MODE` | Set to `'1'` in TUI mode | tui-server |
| `CORTEX_CALLBACK_SOURCE` | Optional callback metadata | cortex-ext |
| `CORTEX_SCHEDULE_TASK_ID` | Optional schedule task ID | cortex-ext |
| `ANTHROPIC_BASE_URL` | Optional API base URL override | Model routing |

## Security considerations

MCP tools give the agent the ability to execute shell commands on remote
machines, read and write files, upload to Slack, and modify schedules. The
security posture assumes:

- The `cortex-client` WebSocket port (3002) is not exposed to the public
  internet. Use Tailscale, a VPN, or localhost-only binding (see
  [cross-machine.md](./cross-machine.md) for network topology options).
- The webhook HTTP port (3001) is bound to `127.0.0.1` only — MCP servers
  talk to it via loopback, not over the network.
- The agent operates within the same blast-radius safety boundaries documented
  in [safety-and-approvals.md](./safety-and-approvals.md). MCP tools cannot
  bypass the need-approval gating for high-privilege operations.
