# MCP — Model Context Protocol

Cortex ships privilege-scoped and platform-scoped MCP (Model Context Protocol)
tools that give agents access to remote machines, subagents, costs,
waitpoints, team workers, boards, and platform integrations. This document explains
what each server provides, how they are composed, and how to add third-party
MCP servers.

## What MCP is

MCP is an open protocol that lets LLM applications expose tools to agents
through a standardized JSON-RPC interface over stdio, HTTP, or an in-memory
transport pair. Cortex uses MCP to bridge between the agent (which reaches no
agent-server internals of its own) and the server's capabilities. MCP support
varies by backend — see the feature matrix in [backends.md](./backends.md).

Claude Code reads MCP server configurations from JSON files and spawns each
stdio server as a child process. The agent then calls MCP tools just like
built-in tools (Bash, Read, Edit, etc.), with the tool names prefixed by
`mcp__<server-name>__`. PI connects MCP servers through Cortex's own bridge:
the bundled Cortex tools keep their bare names, and a plugin server's tools are
named `plugin_tool_plugin_server_<server>_<tool>`.

## Why Cortex ships its own MCP servers

Cortex's agent-server maintains state that the agent process cannot reach
directly: WebSocket connections to remote machines, running subagents and
team workers, waitpoints, the chat platforms, cost records, and the execution
registry. The Cortex MCP tools are a controlled bridge — the agent calls a
tool, the tool asks the server (over the loopback webhook, or by reading the
server's stores), and the result flows back to the agent.

## The bundled MCP servers

The names below are logical capability bundles, not separate processes. Unless
a session's MCP composition is empty, the session gets exactly one Cortex-owned
server built from `agent-server/src/domain/mcp/bundled-server.ts`, registering
only the bundles selected for it. Claude Code starts that server as a stdio
child; PI runs it inside the agent-server process over an in-memory transport
pair, bound to a tool context built for that one session. Under Claude the server
key is `cortex-core`, so every bundled tool carries that prefix — the remote
tools are `mcp__cortex-core__remote_*`, and the context tool is
`mcp__cortex-core__cortex_context`. PI exposes the same tools under their
unprefixed names.

User-provided MCP is outside this bundle. Portable plugin servers, browser MCP,
remote HTTP/SSE servers, and Claude-native MCP from an assigned legacy plugin
keep independent configurations, transports, and failure boundaries.

### cortex-core

Exposes remote-machine operations, the read-only clock, and subagent
delegation. Every session whose MCP composition is not `none` loads it,
subagents included.

| Tool | Parameters | Description |
|---|---|---|
| `remote_bash` | `device`, `command`, `timeout?` (seconds, 1–600, default 120), `description?`, `run_in_background?` | Execute a shell command on a remote device via cortex-client |
| `remote_read` | `device`, `file_path` (absolute), `offset?`, `limit?` | Read a file from a remote device (supports images and PDFs) |
| `remote_write` | `device`, `file_path`, `content` | Write content to a file on a remote device |
| `remote_edit` | `device`, `file_path`, `old_string`, `new_string`, `replace_all?` | Edit a file on a remote device by string replacement |
| `remote_glob` | `device`, `pattern`, `path?` | Find files matching a glob pattern on a remote device |
| `remote_grep` | `device`, `pattern`, `path?`, `glob?`, `type?`, `output_mode?`, `-A?`, `-B?`, `-C?` (alias `context?`), `-i?`, `-n?`, `head_limit?`, `offset?`, `multiline?` | Search file contents on a remote device using ripgrep |
| `current_time` | `timezone?` | Get the current date/time; optional IANA timezone (defaults to server local). Returns Unix epoch, UTC ISO, and localized wall-clock with offset |
| `agent` | single (`description`, `prompt`, `subagent_type`) **or** `parallel[]` **or** `chain[]` (each item `description`, `prompt`, `subagent_type`, `model?`, `backend?`), plus `model?`, `backend?`, `run_in_background?` | Delegate work to an isolated subagent on either backend |
| `agent_stop` | `agent_id` | Stop a running subagent and discard whatever it had produced |

The remote tools are registered by
`agent-server/src/domain/mcp/tools/remote-ops.ts`; `agent` and `agent_stop` by
`agent-server/src/domain/mcp/tools/subagent.ts`.

The remote tools share some behavior:

- The first remote tool in a session's surface carries a catalog of the devices
  registered in `machines.json` in its description, Windows machines marked, so
  the agent knows which `device` values exist. A call to a device that is not
  connected fails with the list of devices that are online.
- `remote_read`, `remote_write` and `remote_edit` add the target's `AGENTS.md`
  ancestor chain on that device to their result, once per file per session (see
  [cross-machine.md](./cross-machine.md#remote-agentsmd-files)).
- `remote_read` returns images and PDFs as media; the server downscales large
  images when `sharp` is available.
- Output above 30,000 characters (`remote_bash`), 20,000 (`remote_grep`) or
  100,000 (`remote_glob`) is saved under `$CORTEX_HOME/tmp/tool-results/`, and
  the tool returns the path with a 2 KB preview.

`agent` replaces Claude Code's built-in `Agent` tool, which Cortex strips from
every Claude spawn. It runs on the same role table as PI's own native `agent`,
can place a child on either backend, and is visible to the daemon — so a
delegated run appears in the parent's transcript, is billed to the parent, and
can be stopped from the UI. A foreground call that is still running after 25
minutes is handed to the background and its result arrives later. See
[backends.md](./backends.md#subagents).

PI sessions never receive the MCP `agent` and `agent_stop`: PI registers its
own `agent`, and two tools of that name cannot coexist. A subagent receives
neither on either backend. That is enforced by the tool allowlist rather than
by the prompt, so a child cannot fan out further no matter what it is asked to
do.

### cortex-workers

The lead's side of [team mode](./team.md). A session selects this bundle when `teamEnabled` is
on and it is a web direct session that is not itself a worker, on Claude and PI alike. Workers and
subagents never load it. Every tool returns at once; worker reports and questions reach the lead
as new messages.

| Tool | Parameters | Description |
|---|---|---|
| `worker_spawn` | `name`, `prompt`, `backend?`, `model?` | Start a persistent worker session with its first task; it runs the lead's current model unless `backend`/`model` (same format as `agent`) name another |
| `worker_send` | `worker`, `message` | Deliver a message to a worker, folded into its running turn or opening a new one |
| `worker_list` | `worker?` | The lead's roster, or one worker with its full last report |
| `worker_stop` | `worker`, `retire?` | Stop a worker's current turn, optionally retiring it |
| `worker_answer` | `request_id`, `answers?`, `approved?`, `feedback?` | Resolve a worker's pending question or plan approval |

The bundle is loaded by `agent-server/src/domain/mcp/bundled-server.ts`; the tools are in
`agent-server/src/domain/mcp/tools/workers.ts` and are served by the `/webhook/team` route.

### cortex-worker-report

A worker's side of [team mode](./team.md). Every worker session loads it, on Claude and PI alike;
leads, ordinary sessions and subagents never do.

| Tool | Parameters | Description |
|---|---|---|
| `mark_routine` | none | Mark the current turn as routine: its final reply is recorded for the lead as an unread update and does not wake it. A failed or stopped turn reports anyway |

The tool is in `agent-server/src/domain/mcp/tools/workers.ts` and is served by the
`/webhook/team` route, which refuses it for a session that is not a worker.

### cortex-ext

Exposes Cortex management tools: cost queries, execution records, context
resolution, and waitpoints. Every top-level session whose MCP composition is
not `none` loads it, on Claude and PI alike. Claude subagents load it too; PI
subagents do not.

| Tool | Parameters | Description |
|---|---|---|
| `cost_query` | `projectId?` | Query current cost: today/month spending, budget limits, remaining budget, API/plan split, source breakdown, token usage; with `projectId`, scoped to that project |
| `query_executions` | `execution_id?`, `status?` (`running`, `completed`, `failed`, `cancelled`, `stale`, `all`), `project?`, `limit?` | Query execution records — filter by status, project, or look up by ID |
| `cortex_context` | _(none)_ | Return the current execution context: `sessionId`, `profile`, `project`, `backend`, and for a scheduled or callback-triggered run `scheduleTaskId` and `callbackSource`; in a Web session also `board`, the board it is bound to (id, title, dir) or null |
| `wait_create` | `label`, `intent`, `members?`, `quorum?`, `fail_fast?`, `max_signals?`, `expires_in_hours?`, `device?` | Arm a waitpoint and return the id, a one-time secret, and ready-to-paste signal commands; then end the turn |
| `wait_check` | `id?` | Inspect one waitpoint, or list everything this session is waiting on |
| `wait_cancel` | `id` | Cancel a waitpoint so it can no longer fire |

`wait_create` is how a session waits for something outside Cortex — a training
run, a build, an eval — without polling it. The external program reports back
with the `cortex-signal` CLI, a loopback `POST /webhook/signal`, or a file
dropped in a spool directory, and the session is woken with the result. See
[waitpoints.md](./waitpoints.md).

Schedules are not MCP tools: agents manage them with the `cortex schedule` CLI
through the `schedule` skill, resolving the project with `cortex_context` and
passing it with `--project` (see [Scheduling](./scheduling.md)).

The bundle is loaded by `agent-server/src/domain/mcp/bundled-server.ts`.
Individual tools are in `agent-server/src/domain/mcp/tools/`.

### cortex-slack

Platform-specific MCP server for Slack. Loaded only when the session originates
from Slack, providing platform-specific file upload and messaging capabilities.

| Tool | Parameters | Description |
|---|---|---|
| `slack_send_file` | `file_path`, `file_name?`, `title?`, `comment?`, `device?` | Upload a file to Slack; with `device`, the file is read on that remote device |

The bundle is loaded by `agent-server/src/domain/mcp/bundled-server.ts`; the tool is in
`agent-server/src/domain/mcp/tools/slack.ts`.

### cortex-feishu

Platform-specific MCP server for Feishu/Lark. Loaded only when the session
originates from Feishu. It exposes a single tool — sending files to a chat.

| Tool | Parameters | Description |
|---|---|---|
| `feishu_send_file` | `file_path`, `file_name?`, `title?`, `channel?`, `device?` | Upload a file to a Feishu chat; with `device`, the file is read on that remote device |

Document, table, spreadsheet, and knowledge-base operations are **not** MCP
tools. They run through the official Lark/Feishu CLI (`@larksuite/cli`), driven
by the `feishu-doc` skill of the built-in `cortex-feishu` plugin, which handles
native tables and block-level edits. See the `feishu-doc` skill for the
install/auth preflight and how to delegate to the CLI's embedded `lark-doc` /
`lark-sheets` / `lark-base` skill guides.

The bundle is loaded by `agent-server/src/domain/mcp/bundled-server.ts`.
The tool is in `agent-server/src/domain/mcp/feishu/file.ts`.

### cortex-web

Platform-specific MCP server for the Web workbench. Loaded only when the session
originates from the Web UI (its channel carries the `web:` prefix), so a Slack-
or Feishu-originated session never sees these tools.

| Tool | Parameters | Description |
|---|---|---|
| `send_file` | `file_path` or `files[]` (`{file_path, file_name?}`), `file_name?`, `caption?`, `device?` | Send one file, or several as one grouped message with a single caption, into the chat as downloadable cards (images and video preview inline); with `device`, the files are read on that remote device |
| `send_view` | `title`, `html` or `file_path`, `caption?`, `height?` (160–900, default 360), `width?` (`narrow`, `wide`, `full`) | Render an HTML view inline in the chat as a live, interactive card |
| `send_decision` | `decisions[]` — each `title`, `decision`, `context`, `reasoning` | Record decisions the agent just made and show them as cards in the chat |
| `board_open` | `title` or `board` (exactly one) | Create a board, or attach to an existing one by id or slug, and bind the session to it |

`send_file`, `send_view` and `send_decision` proxy their payload to the daemon over the loopback webhook rather
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

`width` picks one of three inline card widths: `narrow` (the default) sits in the
chat's text column, `wide` extends to about one and a half columns (up to
1040px), and `full` spans the whole chat pane. `wide` and `full` shrink with
the pane, so on a narrow window both end up as wide as the pane. The tier is
stored with the message, so a view keeps its width across reloads. Only the
inline card on the desktop chat honours it; the expanded and docked views and
the mobile chat always fill the space they have.

`send_decision` is non-blocking: the agent announces choices it made on the
user's behalf and keeps working, rather than putting a question to the user the
way `cortex_ask_user` does. Each decision (up to 10 per call, title ≤120 chars, other fields ≤1000)
renders as a collapsed card in the chat; opening it shows context, decision, and
reasoning. The user can approve (recorded only — nothing is sent to the agent),
request an explanation, or propose a revision; the latter two compose a
templated message that is both recorded on the decision and delivered to the
agent as an ordinary user message. Decisions and their action log persist in the
conversation history, so cards keep their state across reloads and devices.

`board_open` opens the status page of a long task: who is bound to it, how
agents write it, and how it shows in the chat and the workbench are described
under [Boards](./team.md#boards).

The bundle is loaded by `agent-server/src/domain/mcp/bundled-server.ts`.
The tools are in `agent-server/src/domain/mcp/tools/ui-file.ts`,
`agent-server/src/domain/mcp/tools/ui-view.ts`,
`agent-server/src/domain/mcp/tools/ui-decision.ts`, and
`agent-server/src/domain/mcp/tools/ui-board.ts`.

### cortex-interaction-bridge

Direct Claude TUI sessions, user-initiated direct Claude print sessions, and
user-initiated direct PI sessions select this interaction bundle in their
single Cortex MCP server. Where it is loaded, Claude's native
`AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` are removed, so every
question and plan goes through these tools.

| Tool | Parameters | Description |
|---|---|---|
| `cortex_plan_enter` | `reasoning?` | Enters the shared read-only planning protocol: investigate, write the plan under `plan/`, implement only after approval |
| `cortex_plan_exit` | `plan_file_path`, `summary?` | Reads the plan file, submits it for human approval, and blocks until resolved |
| `cortex_ask_user` | `questions[]` (each `question`, `header?`, `options?[]` of `{label, description?}`, `multiSelect?`), `level?` (`info`, `warning`, `error`; `warn` is an alias), `blocking?` | Asks one or more free-text or multiple-choice questions through the session platform, waiting for the answers or continuing without them |

`cortex_ask_user` posts its question card the same way in either mode; the
`blocking` parameter decides how the answer comes back. Blocking is the default:
the tool call waits up to the 30-minute interaction TTL and returns the answers
in its own `tool_result`, so the agent cannot proceed without them. With
`blocking: false` the call returns as soon as the card is posted and the agent
keeps working; when the human answers, the answer is delivered to the session as
an ordinary user message — folded into the running turn if one is still live,
otherwise opening a fresh turn. An unanswered non-blocking card expires on the
same TTL and simply never produces a message. In the workbench, only a blocking
question marks a session as awaiting user action; a session that asked without
blocking keeps rendering as running.

How the cards look on each platform, and how plan approval and questions route
in team mode, is described in
[safety-and-approvals.md](./safety-and-approvals.md#plan-approval-and-questions).
The plan and question handlers are in
`agent-server/src/domain/mcp/tools/interaction-plan.ts` and
`agent-server/src/domain/mcp/tools/interaction-ask.ts`.

## MCP configuration files

Cortex generates the Claude MCP config files at startup (via
`agent-server/src/core/config-generator.ts` and the `ensureMcpConfig()` call
in `agent-server/src/entry/startup-helpers.ts`). A sealed home
(`CORTEX_CONFIG_IMMUTABLE=1`) keeps the files it was given.

| File | Purpose | Server key | Logical bundles |
|---|---|---|---|
| `$CORTEX_HOME/config/mcp-config.json` | The `direct` composition every ordinary Claude session uses | `cortex-core` | core + ext |
| `$CORTEX_HOME/config/mcp-config-empty.json` | The `none` composition: no MCP servers | — | — |
| `$CORTEX_HOME/config/mcp-config-core.json` | Explicit restricted composition | `cortex-core` | core |
| `$CORTEX_HOME/config/mcp-config-interaction.json` | Explicit interaction composition | `cortex-interaction-bridge` | interaction |
| `$CORTEX_HOME/config/mcp-config-slack.json` | Explicit Slack composition | `cortex-slack` | Slack |
| `$CORTEX_HOME/config/mcp-config-feishu.json` | Explicit Feishu composition | `cortex-feishu` | Feishu |
| `$CORTEX_HOME/config/mcp-config-web.json` | Explicit Web composition | `cortex-web` | Web |

Claude sessions load `mcp-config.json` or `mcp-config-empty.json`; the other
five serve callers that pass explicit config paths. Each file follows Claude
Code's standard MCP config format:

```json
{
  "mcpServers": {
    "cortex-core": {
      "command": "node",
      "args": [
        "<install>/agent-server/dist/domain/mcp/bundled-server.js",
        "[\"cortex-core\",\"cortex-ext\"]"
      ],
      "cwd": "<install>/agent-server"
    }
  }
}
```

The config files are rewritten on every agent-server startup, so manual edits
to them do not persist. To customize MCP configuration, use a plugin (see
[Plugin-provided MCP servers](#plugin-provided-mcp-servers)).

A spawn that runs under a tool allowlist — a subagent, or an agent role that
declares one — gets a merged config written to
`$CORTEX_HOME/config/mcp-tool-gates/mcp-composition-<digest>.json`, carrying
the allowlist to the bundled server.

### How the right config gets selected

In `agent-adapter/claude/spawn-args.ts`, a session on the `direct` composition
loads `mcp-config.json`, and one on `none` loads `mcp-config-empty.json` with
`--strict-mcp-config`. The Claude adapter writes the final logical selection
to `CORTEX_MCP_BUNDLES` for the stdio child it spawns: core and ext, plus the
interaction bundle for user-initiated sessions, the workers bundle for a team
lead, the worker-report bundle for a worker, and the platform bundle matching
the session's channel (`slack:`, `feishu:` or `web:`). The plugin MCP
configuration and, for a browser-enabled direct session, the browser MCP
config are added as separate config files.

PI's bridge computes the same logical selection from the session's own
environment and hands it directly to the in-process bundled server, alongside
one independent connection per plugin server; on PI the interaction, workers
and worker-report bundles require the `direct` composition. Subagents run
under an allowlist: Claude subagents receive core (without `agent` and
`agent_stop`) and ext, and PI subagents receive core alone, with no plugin
servers. Allowlists are validated against the selected bundles before the
bundled server registers tools.

## How MCP tools communicate with agent-server

User-provided stdio MCP entries are separate child processes under both
backends, and Claude Code sessions run the Cortex-owned MCP server as a child
too. Cortex MCP tools never reach agent-server in-process state (WebSocket
connections, running sessions, waitpoints) directly, wherever their server
runs. They communicate through two paths:

1. **Loopback webhook** — most tools POST to the server's webhook at
   `http://127.0.0.1:<WEBHOOK_PORT>` (default 3001), authenticated with the
   `CORTEX_WEBHOOK_TOKEN` bearer token in the `x-cortex-token` header. Remote
   machine tools use `/webhook/remote-command`, whose handler in
   `agent-server/src/orchestration/routing/webhook.ts` forwards the request to
   `client-manager.sendCommand()` and on over WebSocket to the device. The
   subagent, team, board, waitpoint, Web delivery (`ui-file`, `ui-view`,
   `ui-decision`) and interaction (`/hook/ask-user-question`,
   `/hook/exit-plan-mode`) tools each have their own route.

2. **Store reads** — `cost_query` reads cost records (`data/costs.jsonl`)
   through the same repository layer as the main server, and
   `query_executions` reads the execution registry (`data/executions.json`).
   Neither writes.

MCP calls and loopback HTTP requests share a 30-minute-30-second infrastructure
deadline. Tool-specific business deadlines remain authoritative: shell commands
use their `timeout` argument, while human interactions retain their 30-minute
response window. The extra 30 seconds lets a business timeout return
its result before an outer transport deadline closes the request.

## Plugin-provided MCP servers

Environment-scoped third-party MCP belongs in a portable Agent Plugins package under `$CORTEX_HOME/plugins/<plugin-id>/`. The package declares servers in root `mcp.json`, and the Plugins tab of an execution environment (**Settings → Environments**) assigns the package to it. The schema supports `stdio`, `streamable-http`, and legacy `sse`; [Skills and Plugins](./skills-and-plugins.md#portable-mcp-servers) documents the complete package and trust model.

A legacy plugin directory is passed through to its backend as it is. Claude can load a Claude-native root `.mcp.json` from such a directory, but Cortex does not inventory, summarize, or acknowledgment-gate those native servers, and PI does not receive them. The guarantees in this section apply to portable root `mcp.json` only (`agent-server/src/domain/plugins/runtime.ts`; `agent-server/src/agent-adapter/claude/spawn-args.ts`).

Cortex validates and normalizes the package once at spawn time. Claude receives a private supplemental configuration layered after the normal Cortex files. Stdio entries remain separate processes; each remote entry becomes a local stdio proxy whose private configuration holds its URL and headers. PI receives the normalized server list with its session request, and its bridge opens each entry's own transport — a stdio child for a stdio entry, a direct HTTP or SSE connection for a remote one. Both remote paths use the same manual-redirect fetch and reject every redirect before a configured header or request body can be replayed. Connection and tool registration are isolated per server. Materialization follows declared dependencies: unavailable plugin-scoped `PLUGIN_DATA` omits its stdio dependents while preserving remote MCP, skills, and bundled tools (`agent-server/src/domain/plugins/runtime.ts`; `agent-server/src/agent-adapter/claude/mcp-config.ts`; `agent-server/src/agent-adapter/claude/remote-mcp-proxy.ts`; `agent-server/src/agent-adapter/pi/mcp-bridge.ts`).

Portable MCP is omitted when the resolved MCP composition is `none`, and subagents load no plugins at all. Top-level Claude and PI sessions receive it only through an assigned plugin (`agent-server/src/domain/plugins/runtime.ts`; `agent-server/src/agent-adapter/pi/adapter.ts`; `agent-server/src/agent-adapter/pi/mcp-bridge.ts`).

The plugin catalog and Settings API expose sanitized summaries. Stdio summaries contain the executable basename, argument count, and environment key names; remote summaries contain the origin and header names. Environment values, full remote URLs, and header values remain server-side (`agent-server/src/domain/plugins/mcp.ts`; `agent-server/src/domain/ui-service/plugins-shared.ts`). Installed stdio commands and their working directories remain administrator-trusted package inputs; the private config and per-server isolation are not a code sandbox.

## Global custom MCP servers

The files under `$CORTEX_HOME/config/mcp-config*.json` describe Cortex's global and session-composed MCP layers. They are rewritten at server startup, so direct edits are temporary. A persistent global server requires an explicit builder and privilege-composition change in `agent-server/src/core/config-generator.ts`; it does not belong in an assignment-scoped plugin.

This distinction keeps global Cortex privileges separate from administrator-installed plugin capabilities. Use a portable plugin when the server should follow environment assignment, and change the global builders only when every eligible session composition should receive the server.

## Permission model

MCP tools cross the trust boundary from the agent process into agent-server
internals and remote machines. Installed plugins are administrator-trusted code. For portable root `mcp.json`,
the assignment confirmation makes the capability addition explicit, but it is
not a sandbox or a separate authorization boundary. Legacy Claude-native MCP
configuration remains outside that confirmation. Cortex applies the following
controls:

1. **Registration-level availability** — the bundled Cortex server registers
   only the logical surfaces selected for that session, and an optional
   canonical tool allowlist filters them further. Top-level sessions receive
   core and ext tools, user-initiated sessions add the interaction tools, a
   team lead adds the worker tools, a worker adds `mark_routine`, and the
   session's platform adds its delivery tools. Subagents receive no delegation
   tools.

2. **A separate Claude configuration** — every Claude process Cortex starts
   runs with `CLAUDE_CONFIG_DIR=$CORTEX_HOME/data/claude`, so MCP servers and
   plugins configured for your terminal's Claude Code (`~/.claude`) are not
   part of a Cortex session. An execution environment's `settingSources` can
   narrow which settings files Claude reads further. Claude-native `.mcp.json`
   inside an explicitly assigned legacy plugin directory is still loaded by
   Claude.

3. **Bypass permissions** — Claude Code is spawned with
   `--dangerously-skip-permissions --permission-mode bypassPermissions`,
   meaning it won't prompt for each MCP tool call. Access control happens at
   the MCP tool implementation level, through `agent:pre-tool` hooks, and
   through the server's webhook token.

4. **Network boundary** — MCP tools that talk to remote machines go through
   the client-manager's WebSocket layer. Only devices registered in
   `machines.json` can connect, and only devices with an active WebSocket
   connection can receive commands.

## Environment variables passed to MCP servers

The bundled Cortex server builds its per-session context from these variables.
Under Claude they are set in the environment of the stdio child; under PI the
same values are passed to the in-process server directly.

| Variable | Source | Used by |
|---|---|---|
| `SLACK_CHANNEL`, `FEISHU_CHANNEL` | The session's channel | Platform-bundle selection, interaction tools, file delivery, subagent and team routing |
| `SLACK_BOT_TOKEN` | Server environment | cortex-slack (`slack_send_file`) |
| `CORTEX_SESSION_ID` | Session context | Interaction tools, `cortex_context`, waitpoints, Web delivery |
| `CORTEX_PROFILE`, `CORTEX_PROJECT`, `CORTEX_BACKEND` | Session context | `cortex_context` |
| `CORTEX_SCHEDULE_TASK_ID`, `CORTEX_CALLBACK_SOURCE` | Set for scheduled or callback-triggered runs | `cortex_context` |
| `CORTEX_WEBHOOK_TOKEN`, `WEBHOOK_PORT` | Server environment | Every tool that calls the loopback webhook |
| `CORTEX_MCP_BUNDLES` | Backend process composition | Bundle selection in the bundled server |
| `CORTEX_MCP_TOOL_ALLOWLIST` | Agent role or subagent spawn | Tool registration filter |
| `CORTEX_CLAUDE_MODEL`, `CORTEX_SUBAGENT_PI_MODELS`, `CORTEX_SUBAGENT_CLAUDE_MODELS` | Session model and model catalog | The `agent` and `worker_spawn` model descriptions |
| `PLUGIN_ROOT` | Resolved selected plugin root | Portable stdio plugin servers |
| `PLUGIN_DATA` | Private persistent per-plugin data directory | Portable stdio plugin servers |

## Security considerations

MCP tools give the agent the ability to execute shell commands on remote
machines, read and write files, delegate to subagents and workers, and post to
the chat platforms. The security posture assumes:

- The `cortex-client` WebSocket port (3002) requires `CORTEX_CLIENT_TOKEN` on
  every connection, and is still best kept off the public internet: use
  Tailscale, a VPN, a tunnel, or localhost-only binding (see
  [cross-machine.md](./cross-machine.md) for network topology options).
- The webhook HTTP port (3001) is bound to `127.0.0.1` only and requires
  `CORTEX_WEBHOOK_TOKEN` — MCP servers talk to it via loopback, not over the
  network.
- The agent operates within the same blast-radius safety boundaries documented
  in [safety-and-approvals.md](./safety-and-approvals.md). MCP tools do not
  exempt a high-privilege operation from that boundary.
