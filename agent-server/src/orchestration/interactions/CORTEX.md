Please update me when files in this folder change

orch/interactions/ — User interaction state layer.
Stores requestId-keyed state machines for specific interaction modes (plan approval, ask-user Q&A, etc.).
Referenced by orch/ upper-layer modules via singleton references, must not inversely depend on layers outside orch/.

| filename | role | function |
|---|---|---|
| `plan-approvals.ts` | singleton | Unified requestId-keyed plan approval state (merges pendingPlans + pendingHookPlans, provides register/lookup/resolve/reject/clearByChannel API, publishes plan.approved on resolve [S6-A]) |
| `interaction-records.ts` | singleton | Persistent interaction ENTITY service for web-conduit ask-user/plan-approval (web-interactions-redesign): create/resolve write created/resolved records into conversation-history JSONL and broadcast `session.interaction` state changes; the in-memory index doubles as the liveness signal (empty after restart ⇒ readers derive still-pending rows to `expired`, no startup scan). First-writer-wins resolve ('resolved'/'already-resolved'/'unknown'), `resolvePendingByChannel` backs `!new` cancellation, `getPendingByChannel` backs sessions.pendingInteraction with FULL payload (incl. planContent) |
| `update-prompt.ts` | factory | createUpdatePrompt — UpdatePrompt impl with 4 pre-registered actionIds (apply/skip/cancel/release-note); handlers dispatch to fetchReleaseNote() or updateMessage() |
