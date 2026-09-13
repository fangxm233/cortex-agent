Please update me when files in this folder change

Agent runtime domain for profiles and provider-attributed turns.

| filename | role | function |
|---|---|---|
| agent-state.ts | state | The one reader/writer of data/agent-state.json; migrates mode.json once |
| config.ts | config | Selects modes and stores Claude credentials |
| facade.ts | core | Drives one run's attempt chain over the engine pool: identity, journalling, accounting. The chain order and the notices it produces now live in domain/runs/{fallback,notices}.ts |
| provider-run-lifecycle.ts | core | Attributes providers and publishes auth lifecycle |
| index.ts | entry | Re-exports the public agents-domain API (profiles/roles/credentials); run entry points and facade/adapter internals are not re-exported |
| profile-manager.ts | core | Resolves profile identities and output caps |
| profile-switch.ts | core | Decides and applies channel profile switches |
| spawn-config.ts | core | Legacy RunAgentOptions/AgentConfig types plus engine-spec helper re-exports |
| subagent/ | subdir | Daemon-side subagent runs: entry, backend dispatch, lifecycle registry (contract lives in core/agents/subagent/) |
