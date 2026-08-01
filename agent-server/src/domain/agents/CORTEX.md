Please update me when files in this folder change

Agent runtime domain — selects Claude/PI profiles and runs provider-attributed agent turns.

| filename | role | function |
|---|---|---|
| config.ts | config | Selects modes, saved API env, and failure policy |
| facade.ts | core | Runs turns with auth events, sinks, and process seams |
| index.ts | entry | Re-exports the agents domain API |
| profile-manager.ts | core | Resolves profiles and provider identities |
| profile-switch.ts | core | Decides and applies channel profile switches |
