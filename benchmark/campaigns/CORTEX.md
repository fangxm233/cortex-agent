Update this file whenever this directory changes

Committed campaign documents declare the trials one `cortex-bench run` executes.

| filename | role | function |
|---|---|---|
| terminal-bench-2.1-deepseek-paid.yaml | campaign | Declares the approved three-task paid production-server direct-arm DeepSeek re-baseline with a $2/trial, $6/campaign envelope |
| terminal-bench-2.1-deepseek-five-arm-rebaseline.yaml | campaign | Declares task c982's open-network five-arm × three-task paid re-baseline and orchestration comparisons |
| terminal-bench-2.1-deepseek-paid-smoke.yaml | campaign | Declares one bounded Cortex-compatible DeepSeek smoke |
| terminal-bench-2.1-vendor-claude-code-single.yaml | campaign | Declares the paid single-task Claude Code gate |
| terminal-bench-2.1-vendor-claude-code.yaml | campaign | Declares the paid three-task Claude Code vendor baseline |
| terminal-bench-2.1-vendor-codex-single.yaml | campaign | Declares the paid single-task Codex live gate |
| terminal-bench-2.1-vendor-codex.yaml | campaign | Declares the paid three-task Codex vendor baseline as one TTL-bound wave |
| terminal-bench-2.1-native-codex-xhigh.yaml | campaign | Declares the paid three-task native Codex xhigh wave over the Codex task variants |
| terminal-bench-2.1-pi-codex-xhigh.yaml | campaign | Declares the paid three-task PI OpenAI Codex xhigh wave over the PI task variants |
| terminal-bench-2.1-cortex-direct-codex-xhigh.yaml | campaign | Declares the paid three-task Cortex direct PI OpenAI Codex xhigh wave over the standard Cortex task variants |
| terminal-bench-2.1-codex-xhigh-mounted-gate.yaml | campaign | Declares the paid three-task three-arm gpt-5.6-sol xhigh gate for the mounted-runtime external-corpus launch path |
| terminal-bench-2.1-tmpdir-gate.yaml | campaign | Declares lab-ksu's one-trial gate re-running the task whose output volume exposed the unmade TMPDIR, before 623 trials depend on the fix |
| terminal-bench-2.1-full-xhigh-baselines.yaml | campaign | Declares lab-ksu's 89-task gpt-5.6-sol xhigh segment for the two vendor baselines |
| terminal-bench-2.1-full-xhigh-cortex.yaml | campaign | Declares lab-ksu's 89-task gpt-5.6-sol xhigh segment for the five Cortex orchestrations |
| terminal-bench-2.1-verifier-environment-smoke.yaml | campaign | Proves in a real trial that the scorer sees the image's own PATH before r3 spends quota |
| terminal-bench-2.1-full-xhigh-baselines-r3.yaml | campaign | Re-runs the two vendor baselines over the 34 tasks any r2 arm failed |
| terminal-bench-2.1-full-xhigh-cortex-r3.yaml | campaign | Re-runs the five Cortex orchestrations over the 34 tasks any r2 arm failed |
| terminal-bench-2.1-cortex-direct-codex-xhigh-recovery.yaml | campaign | Recovers the direct xhigh constraints trial that failed before provider execution |
| terminal-bench-2.1-cortex-direct-codex-xhigh-db-recovery.yaml | campaign | Recovers the direct xhigh db-wal trial that failed before provider execution |
| terminal-bench-2.1-vendor-pi.yaml | campaign | Declares the paid three-task PI vendor baseline against the host DeepSeek relay |
| terminal-bench-2.1-vendor-pi-3c-prefx1.yaml | campaign | Declares the first paid three-concurrency PI stream-failure reproduction wave |
| terminal-bench-2.1-vendor-pi-3c-postfx1.yaml | campaign | Declares the first paid three-concurrency PI stream-fix validation wave |
| terminal-bench-2.1-vendor-pi-handshake.yaml | campaign | Declares task 3ff0's vendor-native one-request PI live handshake |
| terminal-bench-2.1-vendor-pi-single.yaml | campaign | Declares task 3ff0's single-task PI live trial with the committed production envelope |
| terminal-bench-2.1-vendor-pi-stream-diagnosis.yaml | campaign | Declares one approval-bounded PI scheduling replay with sanitized terminal-SSE diagnostics |
| zero-paid-dry-run.yaml | campaign | Declares the neutral ZERO-PAID campaign the runner is proven against |
| zero-paid-external-corpus.yaml | campaign | Declares the ZERO-PAID gate proving an external corpus task and mounted runtimes assemble a trial on an unmodified upstream image |
| zero-paid-failed-agent.yaml | campaign | Declares the ZERO-PAID campaign proving a failed agent is published, scored and followed by the next trial |
| zero-paid-parallel.yaml | campaign | Declares the ZERO-PAID campaign proving concurrent trials hold distinct subnets, addresses and live routes |
| zero-paid-production-coder-review.yaml | campaign | Declares one production coder-review audit-retry ZERO-PAID recording trial using that arm's committed bundle and pinned image |
| zero-paid-production-coder-review-fix.yaml | campaign | Declares one production coder-review reviewer-fix ZERO-PAID recording trial using that arm's committed bundle and pinned image |
| zero-paid-production-direct.yaml | campaign | Declares one production-direct ZERO-PAID recording trial using the committed bundle and pinned image |
| zero-paid-production-manager-qa-off.yaml | campaign | Declares one production manager Q&A-off ZERO-PAID recording trial whose unit of work enters as a task for the built-in dispatcher |
| zero-paid-production-manager-qa-on.yaml | campaign | Declares one production manager Q&A-on ZERO-PAID recording trial with the manager Q&A endpoint explicitly confined |
| results/ | evidence | Holds path-sanitized committed campaign result summaries |
| tasks/ | fixtures | Holds the Harbor task directories that campaign names |

## The network a campaign scores on

Every committed campaign declares a `network` block, and it decides what a score means.

`mode: open` gives the trial container the internet. The three xhigh campaigns and current paid
baselines declare it. Terminal-Bench 2.1 tasks and reference solutions are public, so an open
trial can fetch them: an open-network score measures the agent plus whatever it can look up, not
the agent alone. **Scores recorded from 2026-08-18 onward are not comparable with earlier ones**,
which all ran proxy-only under the previous default-deny admission.

`mode: filtered` with an empty block is that earlier shape exactly — the trial reaches its own
credential route and nothing else. It is what a campaign returns to when the score has to be
trustworthy. Adding `allowlist` entries widens it, enforced by the gost sidecar; the trial's own
proxy host is added automatically and must not be declared.

`denylist` is best-effort ONLY, and the harness records that in every trial's evidence document.
It is enforced as a set of addresses resolved once on the host at admission time, so DNS
rotation, CDN re-mapping, and connecting straight to an IP all defeat it. It keeps an honest
agent off a host; it does not keep a determined one off. Do not use it as the only thing standing
between a trial and the answers.

## How a campaign names its tasks, and what its arms run on

A campaign declares exactly one of `tasks` or `task_source`, and declaring neither or both is
refused.

`tasks` enumerates committed task copies with an inline digest-pinned `image_ref`. It is right for
a handful of tasks whose directories live in `tasks/` under this folder, and it is what every
campaign written before 2026-08-26 uses.

`task_source` names a corpus that is too large to commit — a `root` directory of task folders and
an `inventory` JSON that pins each task's local image id — plus an optional `select` block
(`all` / `include` / `exclude`) to run a subset. Each entry expands into the same digest pin an
inline `image_ref` carries; nothing about the pin gets weaker, it just stops being typed 89 times.
Corpus tasks are staged once per campaign into a sibling of `trials_dir`, keeping only the three
things Harbor reads, with the task's own `docker_image` and `allow_internet` lines rewritten. Both
`root` and the staged inventory are host paths, so a `task_source` campaign belongs to the machine
it was written for, the same way `trials_dir` already does.

`runtimes` names the staged runtime roots this run may mount, and an arm's `runtime_mounts` names
which of them it wants. The campaign declares the SOURCES; the harness owns the container targets,
so a campaign cannot mount a runtime over `/usr/bin`, and every mount is admitted read-only. This
is what lets an arm be measured on an unmodified upstream task image rather than one baked to
carry the same tree — 89 tasks times three vendors is 267 builds, and that cost is why the
89-task suite grew a second runner before this existed. Stage the roots with:

    benchmark/harness/scripts/provision-terminal-bench-images.sh --stage-runtimes <dir>

An arm that mounts anything must mount the CLI of the backend it drives: a Cortex arm on `pi`
needs `pi` as well as `node`, because the server shells out to it. An arm that mounts nothing is
the historical arm, and finds everything it needs baked into its image.

`verifier` is not like the others and may only be mounted under `mode: filtered`. The other
runtimes ADD something no task image carries; `verifier` SUBSTITUTES for something an upstream
`tests/test.sh` obtains for itself. That script apt-gets curl, curls the uv installer, and then
names its own per-task closure on the uvx line — `-w numpy==2.3.1`, `-w torch==2.7.0`,
`-w mteb==1.36.8` — and 32 of the 89 tasks in the 2.1 corpus name something beyond pytest that
way. The staged tree honors none of it: its wheelhouse holds pytest, pytest-json-ctrf and four
transitive dependencies, and its uvx shim drops `-p` and `-w` because offline it has nothing to
install from. Its `apt-get` and `curl` are linked onto `/usr/local/bin`, which precedes
`/usr/bin`, so the upstream script is intercepted at its first line. Offline that is the best
available approximation. Online it is a silent downgrade — the verifier dies importing numpy, the
reward file is written 0, and the trial reads exactly like an agent that failed the task. A
campaign that declares `mode: open` and mounts `verifier` is refused when it is still a document.

## What a task image may declare for itself

A campaign that runs unmodified upstream images inherits whatever those images declare. Until
2026-08-27 admission required an image's own environment to be a subset of the keys the harness
injects, which only an image the harness built could satisfy: 47 of the 89 Terminal-Bench 2.1
tasks were refused, 46 of them for carrying `GPG_KEY`, `PYTHON_VERSION` and `PYTHON_SHA256` —
what `FROM python:3.x` leaves in every image built on it.

That rule was never what kept the image's environment away from the trial. Every command the
harness runs goes through `exec env -i <sealed keys>`, so the agent and the verifier start from an
empty environment holding exactly the sealed values no matter what the image declares. What the
rule actually did was refuse legitimate images for declaring variables that cannot reach the
measured process.

Admission now refuses only the keys that can steer the one process which does inherit the image's
environment — the service's own entrypoint, started by `docker compose up`: the proxy family,
`LD_PRELOAD` and its siblings, `NODE_OPTIONS`, `BASH_ENV`. Everything else is admitted, and the
launch evidence records the image's full declared key set with a digest of its values, so the
attestation describes the whole container rather than only the part the harness supplies. The
integrity guarantee is unchanged and comes from where it always came from: the image is pinned by
digest, so what it declares cannot change without the pin changing.

One consequence is worth knowing before reading a score. `env -i` strips the image's variables
from the agent's environment, so a task whose fixtures expect one — `multi-source-data-merger`
ships `PYTHONPATH=/app:` — is solved without it. That is how this harness has always run tasks,
and it is a property of the measurement, not of the agent being measured.

## What a trial collects, and what it throws away

The sealed environment names four scratch directories under `/logs/agent/trial-home` — `home`
(HOME), `tmp` (TMPDIR/TEMP/TMP), `xdg-cache` (XDG_CACHE_HOME) and `xdg-config` (XDG_CONFIG_HOME).
Naming them means third parties fill them, and until 2026-08-27 all four were collected as trial
evidence. Measured over one campaign's 29 trials: 173.7 MB collected, of which pip's HTTP cache
under `xdg-cache` was 157.84 MB — 91% of all evidence, none of it about the trial.

It was not merely bulky. One cached PyPI response body in it held a package author's `/home/<name>`
path, the leak scanner matched it exactly as it should, and the trial — which had solved its task
with reward 1 — was discarded as an output leak. Chromium separately leaves root-owned directories
under `xdg-config` and `tmp` that the collector cannot traverse, and a single unreadable entry
marks the whole agent root unavailable, failing the trial outright.

The harness now discards those four trees as root inside the live container, after the agent and
the verifier have both finished and before anything is collected, writing
`agent/trial-scratch-discarded.json` first so the evidence still records that each directory
existed and how much it held. The scanner and the collector are unchanged; there is no new
allowance for third-party content, because the third-party content is no longer there. Siblings
under the same root that hold real trial state are untouched: this is four fixed names, not a
wildcard. That distinction is what keeps the leak scan honest — every credential-bearing root the
harness names sits outside HOME on purpose (`codex-home`, `codex-secrets`, `pi-agent`,
`cortex-home`, `claude-config`, `projects`), so all of them are still collected and still scanned.
What is discarded is scratch that no credential is ever written to.

## A scored trial is not a failed trial

A trial that publishes a canonical reward is a measurement, whatever the number. The campaign
ledger used to key `state` off `TERMINAL_SUCCESS`, which called every zero-scoring trial a failure
— including the graded safety refusals, which publish an outer envelope and a reward of 0 exactly
as designed. A run of a benchmark nobody scores 100% on therefore reported `ok: false` and a
non-zero `trials_failed` for doing its job, and the noise hid the trials that really had no
result. `failed` now means what it says: no measurement — a verifier that never scored, a harness
that never finished, an arm that never armed.
