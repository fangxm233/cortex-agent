# Team Mode

Team mode lets one conversation run a team. You talk to a single session, the **lead**, and it
hands work to persistent **worker** sessions, continues them later, answers their questions and
tells you what came back. You never open a session to give a piece of work its own context, or
decide which conversation should carry on with what; the lead does that.

Team mode is experimental and on by default. Turn it off in **Settings → Advanced → Team
(experimental)**, or set `teamEnabled` to `false` in `settings.json` (`CORTEX_TEAM_ENABLED=0`).

## Leads and workers

With team mode on, every web session can lead. Nothing about a session changes until it starts a
worker: one with no workers looks and behaves like any other session. The only difference is a
set of `worker_*` tools in its tool list.

A worker is an ordinary session that belongs to a lead. It has its own transcript, context and
resume history, runs on Claude or PI like any session, and has the full tool surface, including
the one-shot `agent` tool. It cannot start workers of its own, so a team is one level deep.
A worker inherits its lead's project and runs the model the lead is currently on, including any
model, provider or thinking level picked in the composer. The lead can pass `backend` and `model`
in the same format as the `agent` tool (`provider/model[:thinking]` for PI, a bare model id for
Claude): a model on the lead's own backend replaces only the parts it names, and another backend
starts from that backend's default profile, so a Claude lead can run PI workers and the other way
round. A PI model whose provider has a profile of its own runs on that profile. Spawning a worker leaves the model a new conversation opens on unchanged.

A lead uses workers only when there are several tasks (or the work splits into several) or the user
switches to a different task; a single task stays in the lead's own session. For the work it hands
off, the lead chooses between a worker and the one-shot `agent` tool by what happens next. Work that
may need follow-up, runs long, or may need back-and-forth goes to a worker. Bounded reconnaissance or
verification whose result the lead uses straight away goes to `agent`.

## How work flows

```
you ⇄ lead ── worker_spawn / worker_send ──────────▶ worker
        ▲  ◀── report at the end of each worker turn ──┤
        │  ◀── question / plan approval notice ────────┤
        └──── worker_answer ──────────────────────────▶ (pending request resolved)
you ─────────── open the worker and talk to it directly ──▶ worker
```

**Dispatch never blocks.** `worker_spawn` and `worker_send` return at once. The lead ends its
turn, and the worker's report wakes it later. A message sent to a running worker is folded into
its current turn; to an idle worker it starts a new one. While the server is about to restart,
both tools return an error instead of dispatching, and the lead tries again after the restart.

**Reports.** Each worker turn ends in a report unless the worker marks it routine (below): its
final reply reaches the lead as a message headed `[Worker <name> · completed|failed|stopped]` with
a one-line status, and wakes it. A report that arrives while the lead is mid-turn is folded into
that turn. Turns you start yourself by typing in a worker are not reported; the lead's roster
marks that worker as one you have talked to. A server restart does not lose a report: one that
ends while a restart is pending reaches the lead once the server is back. A worker's finished
turn raises no notification on the web page, the desktop app or Android; you hear about it when
the lead's own turn ends. Retired workers stay silent too.

**Routine updates.** A turn with nothing new for the lead, such as a stale or duplicate signal, a
routine check that found everything as expected, or work still running with no change, should not
wake it. The worker marks such a turn by calling `mark_routine` before its final reply. The reply
then shows in the lead's chat as a routine update and in `worker_list`, and goes into the lead's
inbox of unread updates instead of waking it. A failed or stopped turn always reports, marked or
not. The lead reads its unread updates the next time it hears anything: they are appended as the
last section, headed `[Unread routine updates]`, to the next report or question notice it
receives, or added to the `[Team]` block of its next turn, whichever comes first. Each update is
one line, the first line of the reply with its time, grouped by worker. The lead's chat does not
display that section, since each of those updates already has its own row. Once given to the
lead, an update counts as read and is not repeated. The inbox survives a restart and keeps the last
five updates per worker, noting how many older ones it left out.

**Questions and plans.** When a worker calls `cortex_ask_user`, submits a plan with
`cortex_plan_exit`, or submits a commission contract, the request shows up as a card in the
worker's session and as a notice in the lead's conversation. The lead answers with
`worker_answer`. It may answer questions and approve plans on its own judgement, and asks you
with `cortex_ask_user` when it is unsure what you would want. You can answer on the worker's card
yourself; whichever answer arrives first is the one the worker gets.

**Roster.** While a lead has active workers or unread updates, each of its turns opens with a
short `[Team]` block: a few working rules, one line per worker (status, brief, last report, and
whether you have talked to it) and any unread updates. A worker with no turn running that still
holds an open waitpoint is listed as waiting on external, not idle. A worker's first turn opens
with a `[Worker]` block telling it who its lead is and how its replies are used.

**Transcripts.** Every session's first turn names the directory holding all session transcripts
(`<sessionId>.jsonl`). When a report is not enough, the lead can read a worker's full transcript
there, using the session id that `worker_list` shows.

## Tools

The lead's tools come from the `cortex-workers` MCP bundle (see [MCP](./mcp.md)).

| Tool | Parameters | What it does |
|---|---|---|
| `worker_spawn` | `name`, `prompt`, `backend?`, `model?` | Starts a worker named by a short slug and gives it its first task |
| `worker_send` | `worker`, `message` | Continues, redirects or briefs a worker; revives a retired one |
| `worker_list` | `worker?` | The roster, or one worker in detail with its model and full last report |
| `worker_stop` | `worker`, `retire?` | Stops the worker's current turn; `retire` also takes it off the roster |
| `worker_answer` | `request_id`, `answers?` or `approved?` + `feedback?` | Answers a worker's question, or approves or rejects its plan |

Workers get one tool of their own from the `cortex-worker-report` bundle: `mark_routine`, which
takes no parameters and marks the current turn as a routine update (see above).

## In the workbench

- The sidebar nests a lead's workers under it, behind a caret with a worker count. The lead's
  dot summarizes its workers, and retired workers are listed last and dimmed.
- A lead's chat header carries its team as one capsule: a status dot per active worker, needs-you
  first, then a summary such as *7 workers · 3 running · 1 needs you*. Clicking it opens the team
  list. Each row shows a worker's status and how long it has been running or idle, and underneath
  it what the worker is doing: the question it is waiting on you for, its current task while it
  runs, or the brief the lead spawned it with. A row opens that worker. Retired workers are folded
  at the bottom of the list.
- On mobile, the Sessions list leaves workers out. The lead's row carries their state instead: it
  shows as running while any worker runs, and as unread while any worker has news. In the lead's
  chat, a summary row under the header opens the same team list as a sheet. Retired workers count
  toward neither state and are folded at the bottom of the list.
- A worker's header starts with its lead's title, which takes you back to the lead. The composer
  works as in any session, so you can talk to a worker directly.
- A worker that is waiting for its lead to answer shows a hollow ring and *Waiting on lead*. The
  amber dot stays reserved for requests only you can answer.
- In a worker's transcript, messages from the lead appear as your own messages labelled *From
  lead session*.
- In the lead's chat, what the lead does to its workers shows as quiet rows of its own rather than
  tool calls. A spawn is a small card with the worker, its model and the first two lines of its
  brief. A message or an answer is one line naming the worker; click it for the full text. A stop
  is one line too, and says so when the worker was also retired. An answer that directly follows
  its request folds into that request's card.
- Worker traffic in between the lead's replies (reports, routine updates and requests) gathers
  into one card per run. The card shows the worker, its live status, a summary such as *Plan
  approved · 3 reports · 5 routine*, and the latest report or request, or the latest routine
  update in muted text when the run holds nothing else. It opens into a timeline where routine
  updates read quieter than reports and each entry expands to the full text, with a link to the
  worker's session. Several workers in one run get a row each. A worker whose question or plan is
  still unanswered turns its row amber. Live status appears only on a worker's latest card; older
  cards show when they happened.
- When the lead is idle while workers are still running or waiting on something, the chat ends
  with a line naming who it is waiting on, such as *Lead is waiting for docs to report*.

## Limits

- A lead runs at most eight workers at once.
- Only web sessions lead. Slack, Feishu and scheduled sessions do not get worker tools.
- A blocking question or plan waits at most 30 minutes, the same limit as any interaction, and
  pending requests do not survive a server restart.
- Files, views and decisions a worker sends appear in the worker's own session. The worker names
  the paths in its report so the lead can pass them on.
- Workers live as long as their lead. Session retention removes a lead and its workers together.
- With team mode off, leads lose the worker tools and the roster from their next turn, reports
  and request routing stop, and existing workers behave as ordinary sessions whose questions come
  to you. Their finished turns still raise no notification.
