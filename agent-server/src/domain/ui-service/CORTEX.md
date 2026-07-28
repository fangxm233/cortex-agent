Please update me when files in this folder change

Transport-neutral UI queries, mutations, subscriptions, and router.

| filename | role | function |
|---|---|---|
| app-router.ts | router | Maps UI operations into tRPC procedures |
| index.ts | entry | Exports the directory public API |
| input-schemas.ts | schema | Validates input data |
| subscribe.ts | events | Streams filtered UI domain events |
| trpc.ts | router | Creates shared tRPC router primitives |
| types.ts | types | Defines UI service types |
| ui-service.ts | service | Dispatches transport-neutral UI operations |
| mutate/ | directory | Contains UI mutation handlers |
| query/ | directory | Contains read-only UI handlers |
