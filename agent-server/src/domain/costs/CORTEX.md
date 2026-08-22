Please update me when files in this folder change

Cost domain — persists attempt-attributed accounting and pauses work during provider limits or outages.

| filename | role | function |
|---|---|---|
| codex-quota.ts | parser | Parses Codex quota headers, labels, and the notice wire form |
| cost-tracker.ts | core | Records attributed requests, tokens, spend and budgets |
| gateway-manager.ts | core | Manages the local usage gateway process |
| rate-limit-throttle.ts | core | Applies exact provider/window policy and publishes throttle windows |
| resume-registry.ts | core | Tracks provider-attributed interrupted work |
| usage-service.ts | service | Reads gateway quota/spend and PI cached usage safely |
| usage-store.ts | core | Atomically persists newest provider observations |
