# MCP — Model Context Protocol

Cortex ships privilege-scoped and platform-scoped MCP (Model Context Protocol)
servers that give agents access to remote machines, task monitoring, thread
control, scheduling, costs, and platform integrations. This document explains
what each server provides, how they are composed, and how to add third-party
MCP servers.

## What MCP is

MCP is an open protocol that lets LLM applications expose tools to agents
through a standardized JSON-RPC interface over stdio, HTTP, or an in-memory
transport pair. Cortex uses MCP to bridge between the agent (which reaches no
agent-server internals of its own) and the server's capabilities. MCP support
varies by backend — see the feature matrix in [backends.md](./backends.md).

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

The names below are logical capability bundles, not separate processes. Unless
a session's MCP composition is empty, the session gets exactly one Cortex-owned
server built from `agent-server/src/domain/mcp/bundled-server.ts`, registering
only the bundles selected for it. Claude Code starts that server as a stdio
child; PI runs it inside the agent-server process over an in-memory transport
pair, bound to a tool context built for that one session. Claude keeps the
`cortex-core` server key, so core remote tools retain their existing raw names.
Other bundled Claude tools share that prefix, such as
`mcp__cortex-core__task_status`. PI exposes the same tools under their
unprefixed names.

User-provided MCP is outside this bundle. Portable plugin servers, browser MCP,
remote HTTP/SSE servers, and Claude-native MCP from an assigned legacy plugin
keep independent configurations, transports, and failure boundaries.

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

Exposes read-only task monitoring and is loaded in maintained Claude and PI
top-level direct and thread sessions. PI `Agent` subagents receive only
cortex-core.

| Tool | Parameters | Description |
|---|---|---|
| `task_status` | `task_id`, `project?` | Read a task's lifecycle state (status, actionable, claimed_by, blocked_by, deps, parent) |
| `task_result` | `task_id`, `project?` | Read a task's outcome (done/blocked, done_when, completion note, block reason) |
| `task_list` | `project?`, `status?`, `parent?`, `limit?` | List tasks (optionally by status or parent) |

The server implementation is at `agent-server/src/domain/mcp/tasks-server.ts`.

### cortex-manager-qa

Exposes the manager-to-subtask answer channel to top-level direct and thread
sessions. The canonical Claude tool name is
`mcp__cortex-core__answer_subtask`. PI `Agent` subagents do not load this
bundle because they do not own task-tree questions.

| Tool | Parameters | Description |
|---|---|---|
| `answer_subtask` | `question_id`, `answer` | Answer a clarification question from a child task |

The server implementation is at
`agent-server/src/domain/mcp/manager-qa-server.ts`.

### cortex-thread

Exposes thread lifecycle control and upward clarification. For Claude and PI,
it is loaded only when `CORTEX_THREAD_ID` identifies an active thread; direct
sessions never receive these tools.

| Tool | Parameters | Description |
|---|---|---|
| `thread_abort` | `kind`, `diagnosis` | Escalate YOUR OWN thread when the task is too-big / mis-scoped / blocked-external (terminal `aborted`) |
| `thread_split` | `subtasks` | Decompose YOUR OWN task into children (keep-parent join) that flow through the dispatch queue |
| `thread_wait` | `on_tasks?`, `on_threads?` | Suspend YOUR OWN thread until awaited children finish; pair with `cortex-task spawn` |
| `ask_manager` | `question` | Ask the planning manager a blocking clarification question |

The server implementation is at `agent-server/src/domain/mcp/thread-server.ts`.
Tool registrars remain in `agent-server/src/domain/mcp/tools/`.

### cortex-ext

Exposes Cortex management tools: scheduling, cost queries, and context
resolution. Claude loads it only for direct/user sessions; the PI bridge
loads cortex-ext in all top-level sessions.

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

### cortex-web

Platform-specific MCP server for the Web workbench. Loaded only when the session
originates from the Web UI (its channel carries the `web:` prefix), so a Slack-
or Feishu-originated session never sees these tools.

| Tool | Parameters | Description |
|---|---|---|
| `send_file` | `file_path`, `file_name?`, `caption?` | Send a file into the chat as a downloadable card (images and video preview inline) |
| `send_view` | `title`, `html?`, `file_path?`, `caption?`, `height?` | Render an HTML view inline in the chat as a live, interactive card |
| `send_decision` | `decisions[]` — each `title`, `decision`, `context`, `reasoning` | Record decisions the agent just made and show them as cards in the chat |

All three tools proxy their payload to the daemon over the loopback webhook rather
than returning it as tool output: the normalized event stream carries tool
results as flat strings, and the PI backend flattens rich MCP content to text,
so anything richer than a string has to travel out of band. The daemon copies
the bytes into `workspace/outputs/<sessionId>/` (views land one level deeper, in
`views/`), records an assistant message carrying the attachment, and publishes
the live event. Only the path travels — a large document never enters the
transcript or the event stream.

`send_view` takes either an inline `html` string (up to 256KB) or the path to an
`.html` file the agent already wrote (up to 2MB). The view renders in a frame
sandboxed to `allow-scripts` with no `allow-same-origin`, so the document has an
opaque origin: no access to the page, storage, cookies, the Cortex API, or (in
the desktop shell) the auth token and Tauri IPC. It may still load libraries and
data over https. That isolation is why the rendering intent is carried by the
attachment bucket the server mints and never by a file extension — an `.html`
file that a user uploads or that an agent sends with `send_file` opens as source
text, not as a running document.

`send_decision` is non-blocking: the agent announces choices it made on the
user's behalf and keeps working, unlike `cortex_ask_user`, which waits for an
answer. Each decision (up to 10 per call, title ≤120 chars, other fields ≤1000)
renders as a collapsed card in the chat; opening it shows context, decision, and
reasoning. The user can approve (recorded only — nothing is sent to the agent),
request an explanation, or propose a revision; the latter two compose a
templated message that is both recorded on the decision and delivered to the
agent as an ordinary user message. Decisions and their action log persist in the
conversation history, so cards keep their state across reloads and devices.

The server implementation is at `agent-server/src/domain/mcp/web-server.ts`.
The tools are in `agent-server/src/domain/mcp/tools/ui-file.ts`,
`agent-server/src/domain/mcp/tools/ui-view.ts`, and
`agent-server/src/domain/mcp/tools/ui-decision.ts`.

### cortex-interaction-bridge

Direct Claude TUI sessions, user-initiated direct Claude print sessions, and
user-initiated direct PI sessions select this interaction bundle in their
single Cortex MCP server. All three modes share the registrations and
handlers in `agent-server/src/domain/mcp/tools/interaction-plan.ts` and
`agent-server/src/domain/mcp/tools/interaction-ask.ts`.

| Tool | Description |
|---|---|
| `cortex_plan_enter` | Enters the shared read-only planning protocol |
| `cortex_plan_exit` | Reads `plan_file_path`, submits the plan for human approval, and blocks until resolved |
| `cortex_ask_user` | Asks one or more free-text or multiple-choice questions through the session platform and blocks for answers |

The plan and question handlers are in
`agent-server/src/domain/mcp/tools/interaction-plan.ts` and
`agent-server/src/domain/mcp/tools/interaction-ask.ts`.

## MCP configuration files

Cortex auto-generates MCP config files at startup (via
`agent-server/src/core/config-generator.ts` and the `ensureMcpConfig()` call
in `agent-server/src/entry/startup-helpers.ts`). Platform-specific servers
(cortex-slack, cortex-feishu, cortex-web) are dynamically loaded based on the
session's origin platform.

| File | Purpose | Default logical bundles |
|---|---|---|
| `~/.cortex/config/mcp-config.json` | Direct-session Cortex process | core + tasks + manager-Q&A + ext |
| `~/.cortex/config/mcp-config-thread.json` | Thread-session Cortex process | core + tasks + manager-Q&A + thread |
| `~/.cortex/config/mcp-config-core.json` | Explicit restricted composition | core |
| `~/.cortex/config/mcp-config-tasks.json` | Explicit task-monitor composition | tasks |
| `~/.cortex/config/mcp-config-manager-qa.json` | Explicit manager-answer composition | manager-Q&A |
| `~/.cortex/config/mcp-config-interaction.json` | Explicit interaction composition | interaction |
| `~/.cortex/config/mcp-config-slack.json` | Explicit Slack composition | Slack |
| `~/.cortex/config/mcp-config-feishu.json` | Explicit Feishu composition | Feishu |
| `~/.cortex/config/mcp-config-web.json` | Explicit Web composition | Web |

Each file follows Claude Code's standard MCP config format:

```json
{
  "mcpServers": {
    "cortex-core": {
      "command": "node",
      "args": [
        "/path/to/bundled-server.js",
        "[\"cortex-core\",\"cortex-tasks\",\"cortex-manager-qa\",\"cortex-ext\"]"
      ],
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

In `agent-adapter/claude/spawn-args.ts`, direct sessions load
`mcp-config.json`, while thread/template sessions load only
`mcp-config-thread.json`. The Claude adapter writes the final logical selection
to `CORTEX_MCP_BUNDLES` for the stdio child it spawns, adding interaction and
one eligible platform bundle when the session context permits them.
Supplemental portable MCP and browser MCP remain separate config entries.

The thread branch is marked by `session.cortexContext.useCoreMcp`. PI's bridge
computes the same logical selection from the session's own environment and
hands it directly to the in-process bundled server, alongside one independent
state per plugin server. PI `Agent` subagents select only cortex-core. Tool
allowlists are validated against the selected logical union before the bundled
server registers tools.

## How MCP tools communicate with agent-server

User-provided stdio MCP entries are separate child processes under both
backends, and Claude Code sessions run the Cortex-owned MCP server as a child
too. Cortex MCP tools never reach agent-server in-process state (WebSocket
connections, the schedule repo, or the execution registry) directly, wherever
their server runs. They communicate through two paths:

1. **HTTP loopback** — remote machine tools (`remote_bash`, `remote_read`,
   etc.) send HTTP POST to `http://127.0.0.1:3001/webhook/remote-command`.
   The webhook handler in `agent-server/src/orchestration/routing/webhook.ts`
   forwards the request to `client-manager.sendCommand()`, which sends it over
   WebSocket to the remote device.

2. **Shared file access** — schedule, cost, and execution tools read and write
   the shared data files in `~/.cortex/data/` (schedules.json, costs.jsonl,
   executions.json) directly, using the same repository layer as the main
   server process.

MCP calls and loopback HTTP requests share a 30-minute-30-second infrastructure
deadline. Tool-specific business deadlines remain authoritative: shell commands
use their `timeout` argument, while human and manager interactions retain their
30-minute response window. The extra 30 seconds lets a business timeout return
its result before an outer transport deadline closes the request.

## Plugin-provided MCP servers

Target-scoped third-party MCP belongs in a portable Agent Plugins package under `$CORTEX_HOME/plugins/<plugin-id>/`. The package declares servers in root `mcp.json`, and **Settings → Plugins** assigns the package to an agent or template slot. The schema supports `stdio`, `streamable-http`, and legacy `sse`; [Skills and Plugins](./skills-and-plugins.md#portable-mcp-servers) documents the complete package and trust model.

A legacy plugin directory is still passed through to its backend. Claude can load a Claude-native root `.mcp.json` from such a directory, but Cortex does not inventory, summarize, or acknowledgment-gate those native servers, and PI does not receive them. The guarantees in this section apply to portable root `mcp.json` only (`agent-server/src/domain/plugins/runtime.ts:546-562`; `agent-server/src/agent-adapter/claude/spawn-args.ts:224-238`).

Cortex validates and normalizes the package once at spawn time. Claude receives a private supplemental configuration layered after the normal Cortex files. Stdio entries remain separate processes; each remote entry becomes a local stdio proxy whose private configuration holds its URL and headers. PI receives the normalized server list with its session request, and its bridge opens each entry's own transport — a stdio child for a stdio entry, a direct HTTP or SSE connection for a remote one. Both remote paths use the same manual-redirect fetch and reject every redirect before a configured header or request body can be replayed. Connection and tool registration are isolated by process. Materialization follows declared dependencies: unavailable plugin-scoped `PLUGIN_DATA` omits its stdio dependents while preserving remote MCP, skills, and bundled tools (`agent-server/src/agent-adapter/claude/mcp-config.ts:105-164`; `agent-server/src/agent-adapter/claude/remote-mcp-proxy.ts:48-82`; `agent-server/src/agent-adapter/pi/mcp-bridge.ts:279-476`).

Portable MCP is omitted when the resolved MCP composition is `none`, and it is not exposed to restricted PI `Agent` subagents. Normal top-level Claude and PI sessions receive it only through an assigned plugin (`agent-server/src/domain/plugins/runtime.ts`; `agent-server/src/agent-adapter/pi/adapter.ts`; `agent-server/src/agent-adapter/pi/mcp-bridge.ts`).

The plugin catalog and Settings API expose sanitized summaries. Stdio summaries contain the executable basename, argument count, and environment key names; remote summaries contain the origin and header names. Environment values, full remote URLs, and header values remain server-side (`agent-server/src/domain/plugins/mcp.ts:102-216`; `agent-server/src/domain/ui-service/plugins-shared.ts:98-134`). Installed stdio commands and their working directories remain administrator-trusted package inputs; the private config and per-server isolation are not a code sandbox.

## Global custom MCP servers

The files under `$CORTEX_HOME/config/mcp-config*.json` describe Cortex's global and session-composed MCP layers. They are regenerated at server startup, so direct edits are temporary. A persistent global server requires an explicit builder and privilege-composition change in `agent-server/src/core/config-generator.ts`; it does not belong in an assignment-scoped plugin.

This distinction keeps global Cortex privileges separate from administrator-installed plugin capabilities. Use a portable plugin when the server should follow agent or template assignment, and change the global builders only when every eligible session composition should receive the server.

## Permission model

MCP tools cross the trust boundary from the agent process into agent-server
internals and remote machines. Installed plugins are administrator-trusted code. For portable root `mcp.json`,
the assignment confirmation makes the capability addition explicit, but it is
not a sandbox or a separate authorization boundary. Legacy Claude-native MCP
configuration remains outside that confirmation. Cortex applies the following
controls:

1. **Registration-level availability** — the bundled Cortex server registers
   only the logical surfaces selected for that session, and an optional
   canonical tool allowlist filters them further. Both top-level direct and
   thread sessions receive manager-Q&A tools, only thread sessions receive
   thread control, PI `Agent` subagents receive core tools alone, and top-level
   PI sessions retain ext tools.

2. **Claude account-level MCP discovery is disabled** — the setting
   `ENABLE_CLAUDEAI_MCP_SERVERS: "false"` in `~/.cortex/.claude/settings.json`
   prevents account-level auto-discovery. It does not disable Claude-native
   `.mcp.json` inside an explicitly assigned legacy plugin directory. Cortex
   manages bundled and portable MCP through its config layers while preserving
   that legacy backend behavior.

3. **Bypass permissions** — Claude Code is spawned with
   `--dangerously-skip-permissions --permission-mode bypassPermissions`,
   meaning it won't prompt for each MCP tool call. Access control happens at
   the MCP tool implementation level and through the PreToolUse hook system.

4. **PreToolUse guards** — the `tasks-yaml-guard.mjs` hook intercepts
   Edit/Write operations on `TASKS.yaml` files (including remote edits) and
   checks project locks.

5. **Network boundary** — MCP tools that talk to remote machines go through
   the client-manager's WebSocket layer. The `machines.json` registry
   controls which devices are known. Only devices with an active WebSocket
   connection can receive commands.

## Environment variables passed to MCP servers

The MCP server processes receive a subset of the agent server's environment:

| Variable | Source | Used by |
|---|---|---|
| `SLACK_CHANNEL` | Channel parameter at spawn time | cortex-ext (slack_send_file), interaction-server |
| `SLACK_BOT_TOKEN` | process.env | cortex-ext |
| `CORTEX_SESSION_ID` | Session context | interaction-server, context tools |
| `CORTEX_SESSION_NAME` | Session context | context tools |
| `CORTEX_THREAD_ID` | Thread context | cortex-thread tools, PI thread-control predicate, context tools |
| `CORTEX_PROFILE` | Session context | context tools |
| `CORTEX_PROJECT` | Session context | context tools |
| `CORTEX_EXECUTION_ID` | Execution context | task lock hooks |
| `CORTEX_MCP_BUNDLES` | Backend process composition | bundled Cortex MCP server |
| `CORTEX_TUI_MODE` | Set to `'1'` in TUI mode | Claude TUI process |
| `CORTEX_CALLBACK_SOURCE` | Optional callback metadata | cortex-ext |
| `CORTEX_SCHEDULE_TASK_ID` | Optional schedule task ID | cortex-ext |
| `ANTHROPIC_BASE_URL` | Optional API base URL override | Model routing |
| `PLUGIN_ROOT` | Resolved selected plugin root | Portable stdio plugin servers |
| `PLUGIN_DATA` | Private persistent per-plugin data directory | Portable stdio plugin servers |

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
