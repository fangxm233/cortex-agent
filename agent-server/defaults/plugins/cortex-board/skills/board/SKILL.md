---
name: board
description: "Open and keep a board: the live HTML status page the Web UI shows beside a long task. Use whenever this session carries a [Board] block or is bound to a board, before editing any board.html, when you are about to dispatch several workers or start work that will run for many turns or hours, or when the user asks for a board, status page, dashboard or 看板 for a task. Covers board_open / board_close, the preset component classes, editing alongside other sessions, and when to update."
allowed-tools: Read, Edit, Write, Bash, mcp__cortex-core__board_open, mcp__cortex-core__board_close, mcp__cortex-core__send_decision
metadata:
  author: "Cortex"
  version: "1.0.0"
---

# Board

A board is one HTML page per long task, shown in the Web UI beside the conversation and on the phone. The app draws a live strip above the page by itself: title, state, Complete / Abandon, every bound session's status, questions waiting for the user, and the decision stream from `send_decision`. You write the page body: what the task is, where it stands, what comes next, and what needs the user. Someone glancing at it for five seconds should know whether things are on track.

## When to open one

Open a board when:

- you are about to dispatch several workers, or
- the task will clearly span many turns or hours (multi-stage experiments, a refactor in areas, a survey), or
- the user asks for one.

Skip it for a question, a single change, or anything you finish within the turn; the conversation already covers those.

- `board_open({title})` creates a board, writes a scaffold into `board.html`, and binds this session plus your active workers. Workers spawned later inherit the binding.
- `board_open({board: "<id or slug>"})` attaches to an existing board; a closed one reopens.

A session is bound to at most one board. The tool returns the board directory.

## Files

```
<project context>/boards/<slug>/
  board.html       # the page body you edit: body content only, no <html>/<head>
  assets/          # images and other files the page shows or links
  decisions.jsonl  # written by the server from send_decision; never edit
```

## Writing the page

- **Open with the head card**: title, an overall state chip, and a one-line `.lead` saying where things stand. Keep the lead current; it is what the user reads first.
- **Replace the scaffold's examples** with real content on the first fill, and delete sections that do not apply.
- **Use the preset classes** below. They follow the user's theme (light/dark, palette, accent) without any work from you. When they do not fit, write your own HTML, inline SVG charts, or a little inline `style`, and take colours from theme variables (`var(--proto-accent)`, `var(--proto-muted)`, …) rather than fixed values so the page still reads in dark mode.
- **Images** go in `assets/` and are referenced relatively: `<img src="assets/loss.png" alt="loss curve">`. The app inlines them (up to 2 MB each).
- **Outputs** are linked with `<a data-open="out/report.md">report.md</a>`. The path is relative to the board directory and must stay inside it, so write or copy the files you want to link under the board directory. A click opens the file in the app. Ordinary `https://` links open in the browser.
- **Keep it static.** The page runs in a sandbox; scripts are not needed for anything the presets do.
- **Decisions**: record them with `send_decision`; the strip shows them. On the page, keep at most a short "key decisions" row list.
- Write in the user's language.

### States

One vocabulary across `chip`, `step`, `meter i`, `legend .sw` and `ic`:

| modifier | meaning | look |
|---|---|---|
| `ok` | done | success green |
| `run` | in progress | accent |
| `ask` | waiting on the user (a question, a review, a go/no-go) | light amber; nothing else on the page is amber |
| `wait` | blocked on a machine or someone else: queue, GPU, rate limit, external review | hollow, dashed |
| `bad` | failed, unexpected, risk | danger red |
| none | not started | gray |

Use `ask` only for things truly waiting on the user, so the amber stays meaningful.

### Components

| class | use | shape |
|---|---|---|
| `stack` | vertical spacing between blocks | `<div class="stack">…cards…</div>` |
| `card` | a glass panel; one topic each | `<div class="card">…</div>` |
| `grid`, `grid wide-left` | cards side by side (auto columns; `wide-left` is 1.3 : 1) | `<div class="grid wide-left"><div class="card">…</div><div class="stack">…</div></div>` |
| `h`, `.n` | small section heading, optional count | `<div class="h">Acceptance <span class="n">3 / 11</span></div>` |
| `head`, `.meta` | title line | `<div class="head"><h1>Title</h1><span class="chip run">in progress</span><span class="meta mono faint">updated 10-13 09:00</span></div>` |
| `lead` | the one-line status under the head; `<b>` for the key fact | `<div class="lead"><b>Stage B merged.</b> C waits for a GPU.</div>` |
| `chip` + state | a state label | `<span class="chip wait">waiting</span>` |
| `meter`, `legend .sw` | progress, one `<i>` per unit | `<div class="meter"><i class="ok"></i><i class="run"></i><i></i></div>` and `<div class="legend"><span><span class="sw ok"></span>done 1</span></div>` |
| `steps` > `step` + state | stage cards: `.top` (`.k` name + chip), `.t` what it delivers, `.m` a fact | `<div class="step run"><div class="top"><span class="k">C</span><span class="chip run">running</span></div><div class="t">…</div><div class="m">2 / 5</div></div>` |
| `rows` > `row` | lists of acceptance criteria, checkpoints, decisions, risks, outputs: `.id`, `.body` (with `.sub` second line), `.end` | `<div class="row"><span class="ic ok">✓</span><span class="id">A-2</span><span class="body">…<span class="sub">…</span></span><span class="end">4a85587c</span></div>` |
| `ic` + state, `ic risk`, `ic todo` | the icon at the start of a row; you choose the glyph (✓ ◐ ● ◌ ▲ ○) | `<span class="ic risk">▲</span>` |
| `tl` | a timeline card: each row starts with `.when` | `<div class="card tl"><div class="rows"><div class="row"><span class="when">10-13</span><span class="chip ok">done</span><span class="body">…</span></div></div></div>` |
| `mono`, `muted`, `faint`, `code` | text tones and inline code | `<span class="mono faint">…</span>`, `<code>path</code>` |

Plain `p`, `ul`, `table` and `img` are styled to match. The scaffold written by `board_open` has a working example of each component.

## Editing alongside other sessions

The lead and its workers can all edit `board.html`, and the server neither locks nor merges. Edits stay safe when everyone works like this:

- **Re-read `board.html` right before every edit.** Another session may have changed it seconds ago.
- **Make small `Edit`s**: one row, one chip, the lead line. After the first fill, do not rewrite the whole file; a full `Write` silently drops whatever others changed since you read it.
- If an `Edit` fails because the text moved, re-read and apply it to the new text.
- Workers usually touch only their own stage and rows; the lead keeps the head, the lead line and the overall structure.

## When to update

- At milestones: a stage finishes, a result comes in, something merges.
- On state changes: work starts, blocks, fails, needs the user, or unblocks.
- With each update, refresh the head chip, the `.lead` line and the `updated` time.

The board is a summary, not a log. Skip small steps, keep the timeline to notable events (newest first), and trim it when it grows long. The app re-renders an open board within a few seconds of a save.

## Closing

When the work is finished or abandoned, make a final edit (state chip, closing lead line), then call `board_close({status: "done" | "abandoned", note?: "one line on the outcome"})`. Usually the lead closes; the user can also close it from the app. A closed board stays readable, and `board_open({board})` reopens it.

The user may restyle every board with `~/.cortex/config/board.css`; leave that file alone unless they ask.
