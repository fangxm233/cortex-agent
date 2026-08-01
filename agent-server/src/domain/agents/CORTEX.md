Please update me when files in this folder change

Agent runtime domain — selects Claude/PI profiles and runs provider-attributed agent turns.

| filename | role | function |
|---|---|---|
| config.ts | config | Selects modes and persists saved API credentials |
| facade.ts | core | Runs attributed turns with sinks, process/wait seams, and lifecycle helpers |
| provider-run-lifecycle.ts | core | Attributes providers and publishes auth lifecycle |
| index.ts | entry | Re-exports the agents domain API |
| profile-manager.ts | core | Resolves profiles and provider identities |
| profile-switch.ts | core | Decides and applies channel profile switches |
