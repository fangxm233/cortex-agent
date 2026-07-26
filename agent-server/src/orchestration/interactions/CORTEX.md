Please update me when files in this folder change

orch/interactions/ — User interaction state layer.
Stores requestId-keyed state machines for specific interaction modes (plan approval, ask-user Q&A, etc.).
Referenced by orch/ upper-layer modules via singleton references, must not inversely depend on layers outside orch/.

| filename | role | function |
|---|---|---|
| `plan-approvals.ts` | singleton | RequestId-keyed pending plan state and terminal transitions |
| `plan-response.ts` | delivery | Deliver Web/Slack approve or reject to PI or Claude |
| `interaction-records.ts` | singleton | Persist Web interaction snapshots and terminal states |
| `interaction-handlers.ts` | handlers | Register platform ask-user and plan actions |
| `update-prompt.ts` | factory | createUpdatePrompt — UpdatePrompt impl with 4 pre-registered actionIds (apply/skip/cancel/release-note); handlers dispatch to fetchReleaseNote() or updateMessage() |
