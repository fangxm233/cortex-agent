Please update me when files in this folder change

The commission board: one long-horizon task's contract, ledger, projected decisions and gates in a single overlay.
The board is opened globally by a provider; the registry itself is served by `commissions.*` and refreshed by the live hook.

| filename | role | function |
|---|---|---|
| CommissionBoardModalProvider.tsx | provider | Owns board selection, queries, close mutation and session hand-off |
| CommissionBoardModal.tsx | view | Renders the ledger/contract panes, decision stream, gates and close actions |
| CommissionBanner.tsx | view | Persistent chat strip naming the commission and its gate count |
| useCommissionLiveSync.ts | hook | Invalidates commission queries on `commission.updated` |
