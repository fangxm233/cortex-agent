Please update me when files in this folder change

Type and schema boundary re-exporting the agent server UI contract to browser clients.
Compile-time parity checks keep operation maps and runtime validators aligned.

| filename | role | function |
|---|---|---|
| app-router.ts | types | Re-exports the server AppRouter type |
| contract.parity.ts | guard | Checks schema and provider policy op parity |
| dto.ts | types | Re-exports UI DTOs including per-window provider policy types |
| index.ts | barrel | Exposes DTOs, schemas, and router types |
| schemas.ts | schemas | Re-exports server query, mutate and window-target policy schemas |
| schemas.test.ts | test | Tests schemas, window-target provider policy, and plugin ids |
