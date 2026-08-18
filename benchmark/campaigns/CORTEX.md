Update this file whenever this directory changes

Committed campaign documents declare the trials one `cortex-bench run` executes.

| filename | role | function |
|---|---|---|
| terminal-bench-2.1-deepseek-paid.yaml | campaign | Declares the approved three-task paid production-server direct-arm DeepSeek re-baseline with a $2/trial, $6/campaign envelope |
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
