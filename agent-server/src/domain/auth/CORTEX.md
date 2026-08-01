Please update me when files in this folder change

Backend authentication domain normalizes Claude and installed PI account state.

| filename | role | function |
|---|---|---|
| auth-status.ts | core | Produces the secret-free account snapshot |
| index.ts | entry | Exports the authentication domain API |
| pi-runtime.ts | adapter | Loads the installed PI model runtime |
