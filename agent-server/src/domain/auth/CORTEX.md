Please update me when files in this folder change

Authentication domain normalizes provider state, formats summaries, and coordinates login flows and lifecycle events.
It routes required/recovered events into debounced user notices.

| filename | role | function |
|---|---|---|
| auth-events.ts | events | Classifies failures and publishes auth lifecycle |
| auth-format.ts | format | Formats secret-free account status summaries |
| auth-status.ts | core | Projects status and preferred login capability |
| auth-watch.ts | notify | Routes notices and exposes recent reminder state |
| cc-login.ts | adapter | Persists Claude API keys and reloads auth |
| cc-subscription.ts | adapter | Drives abortable Claude subscription login |
| index.ts | entry | Exports the authentication domain API |
| login-flow.ts | core | Coordinates login outcomes, aborts, and safe errors |
| login-service.ts | service | Selects consumers and binds notice flow identity |
| pi-login.ts | adapter | Logs PI providers in with safe flow errors |
| pi-oauth.ts | adapter | Logs OAuth-capable PI providers in safely |
| pi-runtime.ts | adapter | Loads the installed PI model runtime |
