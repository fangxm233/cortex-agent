Update this file whenever this directory changes

Schema-v2 records bind independently auditable mechanism and handshake claims; their v1 field-set
migration is pinned by the harness regeneration command.

| filename | role | function |
|---|---|---|
| claude-subscription.live-handshake-passed.json | evidence | Binds one native-default Claude live handshake |
| claude-subscription.offline-contract-passed.json | evidence | Binds Claude subscription synthetic proof |
| claude-subscription.synthetic-observation.json | evidence | Records the Claude loopback request contract |
| codex-subscription.offline-contract-passed.json | evidence | Binds current Codex zero-paid contract proofs |
| codex-subscription.live-handshake-passed.json | evidence | Binds the current native-default Codex live handshake |
| pi-deepseek-api-key.live-handshake-passed.json | evidence | Binds one production PI live handshake |
| pi-deepseek-api-key.model-metadata.json | evidence | Freezes PI DeepSeek model metadata |
| pi-deepseek-api-key.mutation-manifest.json | evidence | Lists killed security mutations |
| pi-deepseek-api-key.offline-contract-passed.json | evidence | Binds DeepSeek synthetic mutation proof |
| pi-openai-codex-oauth.live-handshake-passed.json | evidence | Binds one PI OpenAI Codex live handshake |
| pi-openai-codex-oauth.offline-contract-passed.json | evidence | Binds PI Codex committed-source-suite offline proof |
