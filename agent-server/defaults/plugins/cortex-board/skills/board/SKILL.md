---
name: board
description: "Open and keep a board: the live HTML status page the Web UI shows beside a long task. Use whenever this session carries a [Board] block or is bound to a board, before editing any board.html, when you are about to dispatch several workers or start work that will run for many turns or hours, or when the user asks for a board, status page, dashboard or 看板 for a task. Covers board_open, the preset component classes, and when to update."
allowed-tools: Read, Edit, Write, Bash, mcp__cortex-core__board_open, mcp__cortex-core__send_decision, mcp__cortex-core__current_time, mcp__cortex-core__cortex_context
metadata:
  author: "Cortex"
  version: "1.5.0"
---

# Board

A board is one HTML page per long task, shown in the Web UI beside the conversation and on the phone. The app names the board and draws a live strip above the page by itself: every bound session's status, questions waiting for the user, and the decision stream from `send_decision`. You write the page body: what the task is, where it stands, what comes next, and what needs the user. Someone glancing at it for five seconds should know whether things are on track.

## When to open one

Open a board when:

- you are about to dispatch several workers, or
- the task will clearly span many turns or hours (multi-stage experiments, a refactor in areas, a survey), or
- the user asks for one.

Skip it for a question, a single change, or anything you finish within the turn; the conversation already covers those.

- `board_open({title})` creates a board, writes a scaffold into `board.html`, and binds this session plus your active workers. Workers spawned later inherit the binding. The conversation shows a card for the new board, and on desktop the board opens beside the chat.
- `board_open({board: "<id or slug>"})` attaches to an existing board.

A session is bound to at most one board. The tool returns the board directory; later, `cortex_context` reports which board this session is bound to (`board`: id, title, dir, or null).

## Files

```
<project context>/boards/<slug>/
  board.html       # the page body you edit: body content only, no <html>/<head>
  assets/          # images and other files the page shows or links
  decisions.jsonl  # written by the server from send_decision; never edit
```

## Writing the page

- **Open with the head**: title, an overall state chip, and a one-line `.lead` saying where things stand. Keep the lead current; it is what the user reads first.
- **Replace the scaffold's examples** with real content on the first fill, and delete sections that do not apply.
- **Use the preset classes** below. They follow the user's theme (light/dark, palette, accent) without any work from you. The page reads as one document: each `card` is a section under its `h` heading, set apart by space rather than a box, and only a `callout` is boxed, for something the user has to act on. When the classes do not fit, write your own HTML, inline SVG charts, or a little inline `style`, and take colours from theme variables (`var(--proto-accent)`, `var(--proto-muted)`, …) rather than fixed values so the page still reads in dark mode.
- **Images** go in `assets/` and are referenced relatively: `<img src="assets/loss.png" alt="loss curve">`. A click opens any board image full size in the app's viewer, so a thumbnail need not be readable at board size; put a set of screenshots or plots in a `gallery`. The app inlines each image up to 2 MB, so resize or compress larger screenshots; a larger one shows as a dashed box that still opens on click. Wrap an image in `<a data-open="…">` to open something else instead.
- **Videos**: `<video src="assets/rollout.mp4" poster="assets/rollout.jpg" controls></video>`. Up to 2 MB plays in place; a larger one shows as a play tile (its `poster` frame, if any) that plays it in the app's viewer.
- **Formulas**: `<span class="tex">\mathcal{L} = \lVert x - \hat{x} \rVert^2</span>` inline, `<div class="tex">…</div>` on a line of its own. Write the TeX as text, with `<` as `&lt;`; the app renders it with KaTeX, as in the chat. Do not use `$…$`: nothing on a board reads it.
- **Outputs**: put a file the user should open into the board's `assets/` and link it with `<a data-open="assets/report.md">report.md</a>`; a click opens it in the app. `data-open` only reaches files inside the board directory, so name anything elsewhere as path text without a link: `<code>experiments/run-12/metrics.json</code>`. Ordinary `https://` links open in the browser.
- **Type**: everything is in the app's face; the mono face (`code`, `pre`, `mono`, a row's `.id`) is only for code, paths, ids and hashes, never for names, times, numbers or labels. Headings and table headers are in sentence case, not capitals.
- **Keep it static.** The page runs in a sandbox; scripts are not needed for anything the presets do.
- **Decisions**: record them with `send_decision`; the strip shows them. On the page, keep at most a short "key decisions" row list.
- Write in the user's language.
- The user may restyle every board with `~/.cortex/config/board.css`; leave that file alone unless they ask.

### States

One vocabulary across `chip`, `step`, `meter i`, `legend .sw` and `ic`. It is the app's own status-dot language:

| modifier | meaning | look |
|---|---|---|
| `ok` | done | success green; a check in a step |
| `run` | in progress | accent, with a soft halo |
| `ask` | waiting on the user (a question, a review, a go/no-go) | amber; nothing else on the page is amber |
| `wait` | blocked on a machine or someone else: queue, GPU, rate limit, external review | hollow ring |
| `bad` | failed, unexpected, risk | danger red |
| none | not started | faint gray |

Use `ask` only for things truly waiting on the user, so the amber stays meaningful.

### Components

| class | use | shape |
|---|---|---|
| `stack` | vertical spacing between sections | `<div class="stack">…cards…</div>` |
| `card` | a section of the page, one topic each: plain, no box | `<div class="card">…</div>` |
| `callout` | the one boxed panel, for something the user has to act on; `callout ask` tints it amber | `<div class="card callout ask"><div class="h">Needs you</div>…</div>` |
| `grid`, `grid wide-left` | sections side by side (auto columns; `wide-left` is 1.3 : 1) | `<div class="grid wide-left"><div class="card">…</div><div class="stack">…</div></div>` |
| `h`, `.n` | section heading, optional count or note in a quieter tone | `<div class="h">Acceptance <span class="n">3 / 11</span></div>` |
| `kicker`, `.meta` | optional muted line above the title: scope, with the updated time on the right | `<div class="kicker">Project · scope<span class="meta">updated MM-DD HH:MM</span></div>` |
| `head`, `.meta` | title line with the overall state; `.meta` (right-aligned) when there is no kicker | `<div class="head"><h1>Title</h1><span class="chip run">in progress</span></div>` |
| `lead` | the one-line status under the head; `<b>` for the key fact | `<div class="lead"><b>Stage B merged.</b> C waits for a GPU.</div>` |
| `chip` + state | a state label: a status dot and a word | `<span class="chip wait">waiting</span>` |
| `meter`, `legend .sw` | progress, one `<i>` per unit | `<div class="meter"><i class="ok"></i><i class="run"></i><i></i></div>` and `<div class="legend"><span><span class="sw ok"></span>done 1</span></div>` |
| `steps` > `step` + state | stages, as rows in two columns: the step's state draws its icon column, `.top` (`.k` name + chip), `.t` what it delivers, `.m` a fact | `<div class="step run"><div class="top"><span class="k">C</span><span class="chip run">running</span></div><div class="t">…</div><div class="m">2 / 5</div></div>` |
| `rows` > `row` | lists of acceptance criteria, checkpoints, decisions, risks, outputs: `.id` (mono), `.body` (with `.sub` second line), `.end` right-aligned meta | `<div class="row"><span class="ic ok">✓</span><span class="id">A-2</span><span class="body">…<span class="sub">…</span></span><span class="end">4a85587c</span></div>` |
| `ic` + state, `ic risk`, `ic todo` | the icon at the start of a row; you choose the glyph (✓ ◐ ● ◌ ▲ ○) | `<span class="ic risk">▲</span>` |
| `tl` | a timeline section: each row starts with `.when` | `<div class="card tl"><div class="rows"><div class="row"><span class="when">MM-DD HH:MM</span><span class="chip ok">done</span><span class="body">…</span></div></div></div>` |
| `gallery` > `figure` | same-size thumbnails of images or videos, each with an optional `figcaption`; `style="--b-thumb:240px"` sets the minimum column width (default 160px) | `<div class="gallery"><figure><img src="assets/a.png" alt="…"><figcaption>run-12 · loss</figcaption></figure>…</div>` |
| `tex` on a `span` / `div` | a formula, inline or on its own line | `<span class="tex">\alpha_t</span>`, `<div class="tex">\frac{a}{b}</div>` |
| `tbl`, `num` | a wide table that scrolls sideways instead of squeezing; `num` right-aligns a numeric `th`/`td` | `<div class="tbl"><table><tr><th>Run</th><th class="num">Success</th></tr><tr><td>run-12</td><td class="num">0.84</td></tr></table></div>` |
| `mono`, `muted`, `faint`, `code` | the code face (code only) and text tones; inline code | `<span class="muted">…</span>`, `<code>path</code>` |

Plain `p`, `ul`, `table`, `img`, `figure` and `pre` are styled to match; `pre` (a log tail, a command) scrolls in place rather than widening the page. The scaffold written by `board_open` has a working example of each component.

## When to update

- At milestones: a stage finishes, a result comes in, something merges.
- On state changes: work starts, blocks, fails, needs the user, unblocks, or finishes.
- With each update, refresh the head chip, the `.lead` line and the `updated` time.
- **Read the clock for every time you write**: the `updated` stamp and each timeline `.when`. Call `current_time` (or run `date`) right then; never estimate a time or reuse one from earlier in the conversation. The timeline is ordered by these times, so a guessed time puts rows from different sessions out of order.

The board is a summary, not a log. Skip small steps, keep the timeline to notable events (newest first), and trim it when it grows long. The app re-renders an open board within a few seconds of a save.
