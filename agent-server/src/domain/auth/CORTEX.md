Please update me when files in this folder change

Authentication domain: classifies provider credential failures and publishes typed auth lifecycle events.
It also turns required/recovered events into debounced user notifications.

| filename | role | function |
|---|---|---|
| auth-events.ts | events | Classifies failures and publishes auth lifecycle |
| auth-watch.ts | notify | Routes debounced authentication notices |
