Please update me when files in this folder change

Agent runtime domain — picks the backend, model, and profile for a channel and runs its agent turns.

| filename | role | function |
|---|---|---|
| config.ts | config | Selects agent mode, model, and retry policy |
| facade.ts | core | Runs agent turns across backends |
| index.ts | entry | Re-exports the agents domain API |
| profile-manager.ts | core | Loads and resolves named agent profiles |
| profile-switch.ts | core | Decides and applies channel profile switches |
