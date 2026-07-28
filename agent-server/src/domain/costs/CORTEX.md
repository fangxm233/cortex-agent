Please update me when files in this folder change

Cost domain — tracks spend against budgets and pauses work when a provider rate limit is reached.

| filename | role | function |
|---|---|---|
| codex-event-format.ts | util | Filters and renders Codex event logs |
| codex-usage-monitor.ts | monitor | Alerts when Codex usage runs low |
| cost-tracker.ts | core | Records spend and checks budgets |
| gateway-manager.ts | core | Manages the local usage gateway process |
| rate-limit-parser.ts | util | Parses provider rate-limit data |
| rate-limit-throttle.ts | core | Tracks provider windows and exact mode gates |
| resume-registry.ts | core | Tracks provider-attributed interrupted work |
