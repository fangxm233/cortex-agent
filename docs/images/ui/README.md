# Web UI screenshots

Screenshots of the Cortex Web UI for the README and docs. They come from an isolated
demo instance (machine name `workstation`). That instance ran real agent sessions on
two neutral demo projects:

- `optimizer-study`: SGD, momentum, Adam and AdamW on scikit-learn digits with a small MLP.
- `paper-notes`: reading notes and a related-work paragraph.

The `general` project holds housekeeping sessions. None of the images contain personal
data.

Desktop shots are 1440×900 CSS px at DPR 2 (2880×1800). Mobile shots are 390×844 at
DPR 3 (1170×2532). All images are palette-compressed PNGs.

| File | What it shows | Suggested caption |
|------|---------------|-------------------|
| `hero-light.png` | Workbench, light theme. Left: the project rail with sessions, two worker sessions under the lead, and schedules. Centre: the lead session with a worker report card, tool-call chips, a decision card and the result plot sent via `send_file`. Right: the study's board in the dock, with its results table. | Cortex runs a research project end to end: sessions, workers, results and a live board in one window. |
| `hero-dark.png` | The same view in the dark theme. | Same view, dark theme. |
| `board.png` | A board in the dock. Live strip with the bound sessions and 7 decisions; head card with state chip and status line; stage cards (done / scheduled); a results table; the merged plot; and the evidence links. | A board keeps a long task readable at a glance: stages, results and decisions, updated by the agents themselves. |
| `team.png` | Team mode. The lead session with the "2 workers" capsule open, a worker's approved-plan card, and two expanded worker report cards with "Open worker session" links. | The lead splits work across workers, approves their plans and merges their reports. |
| `memory.png` | Memory viewer for `optimizer-study`. File tree (mission, STATUS, `experiments/EXP-001..003`, `knowledge/K-001..002`) and the rendered `EXP-001.md` with its frontmatter, run command and results. | Every experiment and finding lands in project memory as a plain Markdown record. |
| `schedules.png` | "Edit schedule" dialog for a daily 09:00 regression check (type, time, engine, message, next run). | Schedules let agents rerun checks and digests on their own. |
| `usage.png` | Project overview: today/week/month spend against the daily budget, a 14-day chart, notes, schedules and the execution list with cost and status. | Each project shows its spend, budget, schedules and every execution. |
| `machines.png` | Machines popover: one connected machine with CPU, RAM, disk, two GPUs, per-GPU processes, and connection/heartbeat/uptime. | See every connected machine's load, GPUs and processes at a glance. |
| `provider-setup.png` | "Model providers" card in setup: OpenAI Codex connected via OAuth, with the provider catalog (API key / OAuth). | Connect a model provider with OAuth or an API key. |
| `plan-approval.png` | A session paused on a plan: the "PLAN · awaiting approval" card with the plan file, "Request changes" and "Approve plan". | Agents propose a plan and wait for your approval before running anything. |
| `ask-user.png` | An agent question card (`cortex_ask_user`) with two single-choice questions, a TTL and "Submit answers". | When an agent needs a decision, it asks with concrete options. |
| `mobile-sessions.png` | Mobile home: the project's session list with a "Needs your input" session at the top. | On the phone: every session and what needs you. |
| `mobile-chat.png` | Mobile chat: the lead session with decision cards and "Started worker" cards. | Follow a session from your phone: decisions, workers and tool calls. |
| `mobile-approvals.png` | Mobile chat with a pending plan card: "Reject with note" / "Approve & run". | Approve a plan from your phone. |
| `mobile-board.png` | Mobile board: live strip, head card, stages and the results table. | Boards work on mobile too. |
| `mobile-ask.png` | Mobile agent question card with options, a default and a countdown before defaults apply. | Answer an agent's question from your phone. |
| `mobile-strip.png` | Three phones side by side (sessions, chat, plan approval) on a transparent background. | Cortex on mobile: sessions, chat and approvals. |
| `pelican-opus-cortex.png` | Cortex's result for "Generate an HTML of a pelican riding a bicycle" with Claude Opus 5.5 at xhigh effort, including its speed, brake and bell controls. Not from the demo instance. | The pelican test in Cortex, Claude Opus 5.5. |
| `pelican-opus-claude-app.png` | The Claude app's result for the same prompt, model and effort. | The pelican test in the Claude app. |
| `pelican-gpt-cortex.png` | Cortex's result for the same prompt with GPT-6.1 Sol at xhigh effort. | The pelican test in Cortex, GPT-6.1 Sol. |
| `pelican-gpt-codex.png` | Codex's result for the same prompt, model and effort. | The pelican test in Codex. |

Notes for reuse:

- `mobile-strip.png` has a transparent background, so it works on both light and dark GitHub themes.
- `board.png` is taller than the others (1682×2442). Embed it at a fixed width, for example `width="640"`.
- The demo machine's hardware (CPU and GPU counts, RAM) shows in `machines.png`. Its process names are generic (`python`).
