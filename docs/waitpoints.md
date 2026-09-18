# Waitpoints

A waitpoint is a durable "wake me when this finishes" object. An agent arms one, hands its
one-time secret to something running outside Cortex — a training run, a build, an evaluation —
and ends its turn. When that thing reports, the session is woken with the result.

Cortex does not start, supervise or adopt the process. You run it exactly as you do today and
append one line.

## Why not just poll

A scheduled check costs a full agent turn every time it fires, and almost every fire only
discovers that the job is still running. A waitpoint costs nothing while you wait: the session is
idle, and the only turn that happens is the one that matters.

## The shape of it

```
agent                          your job                     Cortex
  │ wait_create(label, intent)
  │──────────────────────────▶ (id + secret)
  │ ends its turn
  ⋮                            runs for six hours
  ⋮                            cortex-signal --exit-code $?  ──▶ waitpoint fires
  ◀───────────────────────────────────────────────────────────── session woken
```

## Arming one

`wait_create` takes a `label` (what it is) and an `intent` (what you are waiting for and what you
will do about it). The intent matters more than it looks: you will read it hours later in a fresh
turn with none of today's context, so write it for a stranger.

It returns the id, the secret, and ready-to-paste lines. You never compose those yourself.

```
wait_create({
  label: "arm2 training",
  intent: "the 33k-step run on lab-ksu; when it lands, compare the loss curve against arm6",
})
```

Arm it **before** you start the job, so the signal line goes into the same command. Nothing
signals by itself — Cortex launches nothing and watches nothing, so a waitpoint whose callback was
never wired just sits there until it expires. If the job is already running, the reply's
`attach_to_pid` line watches its pid instead.

Once the callback is in place, **end your turn**. You are not supposed to wait around.

## Signalling it

On the machine running the daemon:

```bash
export CORTEX_SIGNAL_ID=wp_1a2b3c4d5e6f CORTEX_SIGNAL_SECRET=…
python train.py; cortex-signal --exit-code $?
```

`--exit-code` turns `$?` into both a status and a message, which is why the integration is one
line. Everything else is optional: `--message` for a one-line summary, `--member` for which job
this is, `--data @file` or `--data -` to attach a log tail.

Without the CLI, the same thing with curl:

```bash
curl -sS -XPOST http://127.0.0.1:3001/webhook/signal \
  -H 'content-type: application/json' \
  -d '{"id":"wp_1a2b3c4d5e6f","secret":"…","status":"ok","message":"33,120 steps"}'
```

To attach to a process that is *already* running, no feature is needed — wait for the pid and then
signal:

```bash
(while kill -0 12345 2>/dev/null; do sleep 5; done; cortex-signal --status ok) &
```

You do not get an exit code that way (the kernel only hands it to the parent), but you do get told
when it is over.

## On another machine

The daemon's webhook listens on loopback only, so a job on a lab box cannot call it. Pass
`device: "<name>"` to `wait_create` and drop a file instead — the daemon collects it over the
connection the device already holds open, within a sweep tick (30s by default):

```bash
python train.py; s=$?; d=~/.cortex/tmp/signals; mkdir -p "$d"
printf '{"id":"wp_1a2b3c4d5e6f","secret":"…","status":"%s","message":"exit=%s"}' \
  "$([ $s -eq 0 ] && echo ok || echo fail)" "$s" > "$d/$$.tmp" && mv "$d/$$.tmp" "$d/$$.json"
```

Write to `.tmp` and rename — a same-directory rename is atomic, so the collector never reads a
half-written file. Nothing needs to be installed on the device. If the device is offline the files
simply wait there.

That spool directory works on the daemon's own machine too, and `cortex-signal` falls back to it
automatically when the daemon is down, so a signal written during a restart is not lost.

## Waiting on several jobs

Name the members and the waitpoint becomes a barrier:

```
wait_create({
  label: "T2 ladder",
  intent: "all three arms; wake me when they are all in, or as soon as one dies",
  members: ["arm2", "arm6", "arm8"],
})
```

Each job signals with `--member arm2`. By default the first failure wakes you immediately
(`fail_fast`), and otherwise you are woken once, when all three are in — one turn, not three.
Signals arriving within a few seconds of each other are folded into that single wake.

`--status progress` records a heartbeat without resolving anything, for a job that wants to report
milestones without waking anyone.

## What you get when it fires

A message naming the waitpoint, how long you waited, what reported, and the intent you wrote. The
external payload is included but explicitly framed as data — anything holding the secret can write
it, and it arrives in your transcript as a user turn, so it is never to be read as instructions.

If the deadline passes with nobody reporting, you are told that instead. An agent left waiting on
silence is worse off than one told nothing came.

## Seeing it in the UI

A waitpoint belongs to a session, so that is where it shows up — no separate dashboard to go
looking at.

**Above the composer.** While a session is waiting on anything, a one-line rail sits directly above
the input: `waiting on 2 signals · train-arm2 · expires in 3h`. Click it open for the full picture —
the intent the agent wrote, quorum progress, every signal received so far with its source, and a
cancel button. It renders nothing at all when nothing is armed, so an ordinary session is unchanged.

Only armed waitpoints appear. One that fires or expires has already posted its own notice into the
transcript; repeating it in a panel would tell the same story twice.

**In the session list.** A session waiting on an external signal carries a hollow ring next to its
name — deliberately not the amber dot, which is reserved everywhere in Cortex for "blocked on YOU"
(a pending question or plan approval). Waiting on a machine asks nothing of you, and should not
compete for the attention of the one marker that does.

**Three things worth looking for** in the expanded rail, each a way a wake can fail silently:

| Badge | Means |
|---|---|
| `wake limit reached (12/h)` | The cap has latched. Signals are still recorded but **no longer wake this session**, and the latch never resets. |
| `delivery retrying · N attempts` | A signal landed but the wake did not. Hover for the error. |
| `N/12 wakes this hour` | The budget is nearly spent. |

The signal secret is not shown: only its hash is stored, and the plaintext is handed out once when
the waitpoint is armed. The UI can copy the id, never the credential.

Which waitpoints count as "this session's" is the union of two rules: the session armed it, **or**
its wake will be delivered here. The second is what the notifier actually uses, so a waitpoint armed
by an earlier session on the same channel (after `!new`, or on a re-run of a schedule) shows up on
the session that will really receive it.

## Housekeeping

| | |
|---|---|
| Default lifetime | 7 days (`CORTEX_WAITPOINT_TTL_MS`), hard ceiling 30 days |
| Collection interval | 30s (`CORTEX_WAITPOINT_SWEEP_MS`) |
| Wake cap | 12/hour per waitpoint (`CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR`) |
| One-shot by default | `max_signals` > 1 turns it into a mailbox |

`wait_check` shows what you are waiting on; `wait_cancel` disarms one you no longer care about —
worth doing, since an abandoned waitpoint wakes you days later about something nobody remembers.

## Security

The secret is a capability scoped to exactly one waitpoint: it can resolve that waitpoint and do
nothing else. This is why the signal route does not take `CORTEX_WEBHOOK_TOKEN` — that token grants
command execution on every connected device, and a training script has no business holding it.

Secrets are stored hashed, compared in constant time, and expire with the waitpoint. Payloads are
size-capped, and unknown ids are rate-limited and recorded so a typo in a script is findable rather
than silent.
