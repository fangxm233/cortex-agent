Please update me when files in this folder change

Cost domain — persists attempt-attributed accounting and pauses work during provider limits or outages.

| filename | role | function |
|---|---|---|
| codex-quota.ts | parser | Parses Codex quota headers and the notice wire form |
| cost-tracker.ts | core | Records attributed requests, tokens, spend and budgets |
| gateway-manager.ts | core | Manages the local usage gateway process |
| rate-limit-throttle.ts | core | Publishes provider windows, auto-resume, and manual early release |
| resume-registry.ts | core | Tracks provider-attributed interrupted work |
| usage-store.ts | core | Persists latest backend-neutral provider usage |
