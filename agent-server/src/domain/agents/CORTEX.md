Please update me when files in this folder change

Agent runtime domain for profiles and provider-attributed turns.

| filename | role | function |
|---|---|---|
| config.ts | config | Selects modes and stores Claude credentials |
| facade.ts | core | Orders continuations and exact accounting |
| provider-run-lifecycle.ts | core | Attributes providers and publishes auth lifecycle |
| index.ts | entry | Re-exports the agents domain API |
| profile-manager.ts | core | Resolves profiles and provider identities |
| profile-switch.ts | core | Decides and applies channel profile switches |
| spawn-config.ts | core | Builds spawn config and resolves plugin runtime |
