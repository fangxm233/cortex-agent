Please update me when files in this folder change

Authentication domain normalizes provider state and coordinates credential lifecycle events and login flows.
It routes required/recovered events into debounced user notices.

| filename | role | function |
|---|---|---|
| auth-events.ts | events | Classifies failures and publishes auth lifecycle |
| auth-status.ts | core | Produces and formats secret-free account status |
| auth-watch.ts | notify | Routes debounced authentication notices |
| index.ts | entry | Exports the authentication domain API |
| login-flow.ts | core | Coordinates expiring login prompts and notices |
| pi-runtime.ts | adapter | Loads the installed PI model runtime |
