Please update me when files in this folder change

Authentication domain normalizes provider state and publishes credential lifecycle events.
It routes required/recovered events into debounced user notices.

| filename | role | function |
|---|---|---|
| auth-events.ts | events | Classifies failures and publishes auth lifecycle |
| auth-status.ts | core | Produces the secret-free account snapshot |
| auth-watch.ts | notify | Routes debounced authentication notices |
| index.ts | entry | Exports the authentication domain API |
| pi-runtime.ts | adapter | Loads the installed PI model runtime |
