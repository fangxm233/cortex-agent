Please update me when files in this folder change

Cost domain — tracks spend and pauses automated work during provider limits and transient outages.

| filename | role | function |
|---|---|---|
| codex-quota-headers.ts | parser | Turns Codex quota headers into throttle windows |
| cost-tracker.ts | core | Records spend and checks budgets |
| gateway-manager.ts | core | Manages the local usage gateway process |
| rate-limit-throttle.ts | core | Publishes provider windows, auto-resume, and manual early release |
| resume-registry.ts | core | Tracks provider-attributed interrupted work |
