Please update me when files in this folder change

User-defined PI providers: a self-hosted or proxied endpoint declared once and routed through the gateway.
A definition lives in PI's own catalog; its upstream URL and key live in the gateway route beside it.

| filename | role | function |
|---|---|---|
| custom-provider-model.ts | core | Validates definitions and derives routes and catalog entries |
| models-json-store.ts | store | Reads and merge-writes PI's user provider catalog |
| gateway-route-store.ts | store | Reads, upserts and removes a single gateway route |
| custom-provider-service.ts | service | Lists, saves and removes providers across both files |
| index.ts | entry | Exports the custom PI provider API |
