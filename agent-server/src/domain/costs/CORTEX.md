Please update me when files in this folder change

Cost domain — tracks spend and pauses automated work during provider limits and transient outages.

| filename | role | function |
|---|---|---|
| cost-tracker.ts | core | Records spend and checks budgets |
| gateway-manager.ts | core | Manages the local usage gateway process |
| rate-limit-throttle.ts | core | Tracks provider limit and outage windows |
| resume-registry.ts | core | Tracks provider-attributed interrupted work |
