Please update me when files in this folder change

Type and schema boundary re-exporting the agent server UI contract to browser clients.
Compile-time parity checks keep operation maps and runtime validators aligned.

| filename | role | function |
|---|---|---|
| app-router.ts | types | Re-exports the server AppRouter type |
| contract.parity.ts | test | Checks schema and DTO operation parity |
| dto.ts | type | Exports shared UI and platform DTOs |
| index.ts | barrel | Exposes DTOs, schemas, and router types |
| schemas.ts | schema | Exports shared input schemas and platform writes |
| schemas.test.ts | test | Tests compact transcript/detail schema behavior, window-target provider policy, and plugin ids |
