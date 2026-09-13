Please update me when files in this folder change

Agent runtime domain: profiles, modes, credentials and provider identity. Running an agent belongs to domain/runs/.

| filename | role | function |
|---|---|---|
| agent-state.ts | state | The one reader/writer of data/agent-state.json; migrates mode.json once |
| config.ts | config | Selects modes and stores Claude credentials |
| provider-run-lifecycle.ts | core | Resolves rate-limit provider identity and mode gating; run.ts owns per-run attribution and the auth lifecycle |
| index.ts | entry | Re-exports the public agents-domain API (profiles/modes/credentials/channel selection); starting a run, compaction and the engine spec live in domain/runs/ |
| profile-manager.ts | core | Resolves profile identities and output caps |
| profile-switch.ts | core | Decides and applies channel profile switches |
| subagent/ | subdir | Daemon-side subagent runs: entry, backend dispatch, lifecycle registry (contract lives in core/agents/subagent/) |
