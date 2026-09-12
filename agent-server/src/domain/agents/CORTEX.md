Please update me when files in this folder change

Agent runtime domain for profiles and provider-attributed turns.

| filename | role | function |
|---|---|---|
| config.ts | config | Selects modes and stores Claude credentials |
| facade.ts | core | Freezes identity and journals attributed adapter turns; runAgent/runAgentOnce are internal to the run layer |
| provider-run-lifecycle.ts | core | Attributes providers and publishes auth lifecycle |
| index.ts | entry | Re-exports the agents domain API, excluding runAgent/runAgentOnce (start a run via @domain/runs/service.js) |
| profile-manager.ts | core | Resolves profile identities and output caps |
| roles.ts | core | Owns the one agent role table both backends delegate through |
| profile-switch.ts | core | Decides and applies channel profile switches |
| spawn-config.ts | core | Legacy RunAgentOptions/AgentConfig types plus engine-spec helper re-exports |
| subagent/ | subdir | Backend-neutral subagent runs: schema, dispatch, orchestration, registry |
