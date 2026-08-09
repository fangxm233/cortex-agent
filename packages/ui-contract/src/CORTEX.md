Please update me when files in this folder change

Type and schema boundary re-exporting the agent server UI contract to browser clients.
Compile-time parity checks keep operation maps and runtime validators aligned.

| filename | role | function |
|---|---|---|
| app-router.ts | types | Re-exports the server AppRouter type |
| contract.parity.ts | guard | Checks schema and operation map parity |
| dto.ts | types | Re-exports UI DTOs including plugin contracts |
| index.ts | barrel | Exposes DTOs, schemas, and router types |
| schemas.ts | schemas | Re-exports server query and mutation schemas |
| schemas.test.ts | test | Tests schema coverage and plugin registration |
