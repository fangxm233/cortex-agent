# Safety and Approvals

Cortex can edit files, spawn processes, manage GPU training, and talk to
multiple machines. The safety-and-approvals system defines what the agent can
do autonomously, what requires your sign-off, and what is never permitted. It
also provides the machinery for you to review and approve pending operations
from Slack. The approval flow is built on the hook-bridge (see
[hooks.md](./hooks.md)) and MCP tools (see [mcp.md](./mcp.md)).

## The three blast-radius classes

Cortex classifies every agent operation into one of three buckets. The
classification lives in the root CORTEX.md "安全边界" (Safety Boundary) section
and is the single source of truth. The judgment criterion is **behavioral
impact**, not file category — fixing a typo in a skill file and adding a new
workflow step to it are different classes of operation even though both touch
`.claude/skills/`.

### Self-serve (autonomous)

Operations the agent can perform without asking. These are read-only
information gathering, local state updates, and low-risk maintenance.

- Read files, check GPU status, read logs, small test scripts
- Update context files (STATUS.md, experiments/, knowledge/, OVERVIEW.md,
  TASKS.yaml)
- Web search, knowledge scans
- Start training runs within budget (GPU preflight required)
- Run analysis scripts
- Skill maintenance changes (typo fixes, format alignment, description
  rewording — no behavioral change)
- Agent-server non-behavioral fixes (syntax errors, log messages, comment
  updates)

### Needs approval (requires sign-off)

Operations that change system behavior, consume significant resources, or are
hard to reverse. These are queued to PENDING_APPROVALS.md and blocked until
you approve them.

- Modify CORTEX.md or CLAUDE.local.md
- New skills or skill behavioral changes (new triggers, new workflow steps,
  capability expansion)
- Agent-server behavioral or architectural changes (new features, protocol
  changes, API changes)
- Over-budget training tasks, large-scale architecture modifications
- Delete files or data
- Modify model code or training configurations
- Kill app.js or daemon processes

### Forbidden (never permitted)

Operations the agent will refuse even if you ask for approval. These are
system-level changes that could destabilize the machine.

- Install system-level packages
- Modify system configuration
- `rm -rf`

### Decision table

The judgment examples from the safety boundary, for reference when
classifying an edge case:

| Operation | Class | Reason |
|---|---|---|
| Fix typo in skill SKILL.md | Self-serve | Maintenance, no behavioral change |
| Add new workflow step to a skill | Needs approval | Changes behavioral logic |
| Fix agent-server syntax error | Self-serve | Non-behavioral fix |
| Add new guard logic to agent-server | Needs approval | Changes behavior |
| Start GPU training within budget | Self-serve | Within budget, but GPU preflight required |
| Modify CORTEX.md rules | Needs approval | System convention change |

## How the agent decides: the `need-approval` skill

Before executing any non-trivial operation, the agent runs the `need-approval`
skill (located in `plugins/cortex-stage-gate/skills/need-approval/`). The
skill performs a three-step process:

1. **Classify** the operation against the safety boundary rules from
   CORTEX.md. The skill has a synced copy of the classification table and
   applies the same judgment heuristics.

2. **If approval is needed**, record the operation to
   `~/.cortex/context/PENDING_APPROVALS.md` with enough detail for you to
   decide without asking follow-up questions. The entry format is:

   ```markdown
   ## [timestamp]
   - **Operation**: [concise description of what will be done]
   - **Reason**: [why this operation is needed]
   - **Impact**: [what it affects — files, machines, resources]
   - **Command/Action**: [the specific command or change to execute]
   - **Status**: pending
   ```

   The agent then outputs `Queued for approval: [one-line summary]` and blocks
   further action.

3. **If no approval is needed**, the agent outputs `No approval needed — safe
   to execute.` and proceeds directly.

The guiding principle is: when in doubt, queue it. Better to over-ask than to
break something.

## How you approve or reject

### Via Slack (primary path)

Use the `/approval` command in your admin DM channel (see
[slack-setup.md](./slack-setup.md) for how the admin channel is configured). The `approval` skill
(part of the cortex-system plugin) reads PENDING_APPROVALS.md and presents
each pending item. Reply with `approve 1` or `reject 2` to act on specific
entries.

For the ExitPlanMode workflow specifically, Cortex presents an interactive
Slack message with **Approve** and **Provide Feedback** buttons. Clicking
Approve signals the agent to proceed with the plan. Clicking Provide Feedback
opens a modal where you can type your rejection reason — the agent receives
that text and can revise the plan.

### What happens after

- **Approved**: the agent executes the queued operation. The
  PENDING_APPROVALS.md entry is updated to `Status: approved` with a timestamp.
- **Rejected**: the operation is not executed. The entry is updated to
  `Status: rejected`. The agent may propose an alternative approach.
- **Timeout**: pending requests in the hook-bridge expire after 30 minutes.
  If you don't respond in Slack within that window, the agent's hook times out
  and it will prompt again.

## Slack approval flow in detail

There are two distinct approval pathways, depending on what triggered the
user interaction.

### Plan approval (ExitPlanMode)

When the agent calls ExitPlanMode (typically during a thread execution), the
flow is:

1. The agent's PreToolUse hook fires, making an HTTP POST to
   `agent-server:3001/hook/exit-plan-mode` with the plan content.
2. The hook-bridge (`agent-server/src/orchestration/routing/hook-bridge.ts`)
   registers the request in an in-memory `pendingRequests` map with a 30-minute
   TTL, and publishes a `plan.submitted` event on the event bus.
3. The hook-bridge subscriber
   (`agent-server/src/orchestration/routing/hook-bridge-subscribers.ts`) receives
   the event, registers the plan in the `PlanApprovals` singleton, and posts an
   interactive Slack message with Approve and Provide Feedback buttons.
4. When you click a button, the Slack interaction handler
   (`agent-server/src/orchestration/interactions/interaction-handlers.ts`)
   resolves or rejects the plan:
   - **Approve** → publishes `plan.approved` on the event bus, resolves the
     pending HTTP request, and the agent's hook script returns success, allowing
     the agent to proceed.
   - **Reject** → the pending HTTP request resolves with `approved: false` and
     your feedback text, which the agent receives and can use to revise.

### User questions (AskUserQuestion)

When the agent calls AskUserQuestion (e.g., to clarify a design choice), the
flow is structurally identical but uses different events:

1. HTTP POST to `agent-server:3001/hook/ask-user-question` with question
   definitions.
2. The hook-bridge publishes `ask-user.requested` on the event bus.
3. The subscriber posts a Slack message with an **Answer** button.
4. Clicking Answer opens a modal form (single-select, multi-select, or text
   input per question).
5. On modal submit, the handler publishes `ask-user.answered` and resolves the
   HTTP request with the user's answers.

A question the agent raises through `cortex_ask_user` with `blocking: false`
travels the same five steps, with one difference at each end: the HTTP request
returns the moment the card is posted rather than waiting on step 5, and the
answers collected in step 5 are routed into the session as an ordinary user
message instead of into a pending `tool_result`. The pending record still exists
so the 30-minute TTL expires an unanswered card and clears its question group.

### PI backend difference

The PI backend resolves these dialogs differently. A PI session raises them
through PI's extension UI protocol, which
`agent-adapter/pi/ui-context.ts` hosts inside the server process: each dialog
becomes an `extension_ui_request` record carrying its own id, and the answer
travels back through `sendExtensionUiResponse()` instead of resolving a pending
HTTP request. The hook-bridge provides non-blocking publish helpers
(`publishPlanSubmitted`, `publishAskUserRequested`) for this path.

## Why the agent isn't given root

Cortex operates with the same privileges as the user who launched it. There is
no `sudo`, no Docker socket, and no privilege escalation path. The forbidden
bucket (installing system packages, modifying system config, `rm -rf`) exists
to prevent the agent from destabilizing the machine even if it has the Unix
permissions to do so.

On remote machines, the `cortex-client` process also runs as the user who
started it — no privilege escalation. The WebSocket protocol between server and
client has no authentication token (it trusts the network boundary), so the
client should only be exposed on localhost or behind a Tailscale/VPN perimeter.

## Audit trail

Approvals are logged in three places:

1. **PENDING_APPROVALS.md** — each queued operation is appended here with
   full detail and final status (approved/rejected). This is the human-readable
   audit trail.
2. **Event bus JSONL** — `plan.submitted` and `plan.approved` events are
   persisted by the event logger to daily-rolling `events-YYYYMMDD.jsonl` files
   in `~/.cortex/data/`.
3. **Slack conversation** — every approval interaction leaves a visible Slack
   message with the Approve/Provide Feedback buttons or the question modal.
   The conversation history is the operational record.

## Configuration

The safety boundary classification lives in the root CORTEX.md at
`~/.cortex/CORTEX.md` under the "安全边界" (Safety Boundary) section. The
`need-approval` skill maintains a synced copy. If you modify the safety
boundary rules, update both locations.

The PENDING_APPROVALS.md file lives at `~/.cortex/context/PENDING_APPROVALS.md`.
It is created automatically on first use.

No additional configuration is required — the approval system is built into
the agent's core reasoning and fires automatically when the agent considers
a high-privilege operation.
