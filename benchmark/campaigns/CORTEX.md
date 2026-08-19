Update this file whenever this directory changes

Committed campaign documents declare the trials one `cortex-bench run` executes.

| filename | role | function |
|---|---|---|
| terminal-bench-2.1-deepseek-paid.yaml | campaign | Declares the approved three-task paid production-server direct-arm DeepSeek re-baseline with a $2/trial, $6/campaign envelope |
| terminal-bench-2.1-deepseek-paid-smoke.yaml | campaign | Declares one bounded Cortex-compatible DeepSeek smoke |
| terminal-bench-2.1-vendor-claude-code.yaml | campaign | Declares the dry-run-only three-task Claude Code vendor baseline |
| terminal-bench-2.1-vendor-codex.yaml | campaign | Declares the dry-run-only three-task Codex vendor baseline |
| terminal-bench-2.1-vendor-pi.yaml | campaign | Declares the paid three-task PI vendor baseline against the host DeepSeek relay |
| terminal-bench-2.1-vendor-pi-handshake.yaml | campaign | Declares task 3ff0's vendor-native one-request PI live handshake |
| terminal-bench-2.1-vendor-pi-single.yaml | campaign | Declares task 3ff0's single-task PI live trial with the committed production envelope |
| zero-paid-dry-run.yaml | campaign | Declares the neutral ZERO-PAID campaign the runner is proven against |
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

`mode: open` gives the trial container the internet. All nine campaigns declare it today. The
Terminal-Bench 2.1 tasks and their reference solutions are in a public repository, so an open
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
