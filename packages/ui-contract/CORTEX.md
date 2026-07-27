# ui-contract/ — @cortex-agent/ui-contract

Shared client↔server contract for the Cortex Web UI (DR-0018 §2). The frontend
imports **only types + zod input schemas + the AppRouter type** from here, so the
backend contract has one source of truth and cannot drift. DTO types AND the zod
input schemas are re-exported (not copied) from `agent-server`'s built `ui-service`
module; DTOs are type-only (erased), schemas are a runtime re-export. The AppRouter
type is a type-only re-export from the in-core tRPC binding
`@cortex-agent/server/dist/domain/ui-service/app-router.js` (merged back into the server
package per plan §11, reversing the Stage-9 §9.1 split to `@cortex-agent/ui-server`).
Depends only on `@cortex-agent/server`, which does not depend on this package — a
one-directional (acyclic) edge, so `pnpm -w build` orders server → ui-contract.

| filename | role | function |
|---|---|---|
| `src/dto.ts` | types | Type-only ui-service DTO re-exports, including `SessionContextUsage`, chat notices, DEBUG details, and pending rows |
| `src/schemas.ts` | schemas | Runtime + type re-export of `queryInputSchemas` / `mutateInputSchemas` (+ the individual schemas) from `@cortex-agent/server/dist/domain/ui-service/input-schemas.js`. Source of truth lives in agent-server so the tRPC router can consume the schemas without agent-server importing this package (which would close a build cycle) |
| `src/contract.parity.ts` | guard | Compile-time drift guard: `z.infer<schema>` ≡ `QueryParamMap`/`MutateArgsMap`; typecheck fails if a schema falls out of lock-step |
| `src/app-router.ts` | types | Type-only re-export of the real `AppRouter` from `@cortex-agent/server/dist/domain/ui-service/app-router.js` (in-core tRPC binding) |
| `src/index.ts` | barrel | Public entry: re-exports dto + schemas + AppRouter |
| `src/schemas.test.ts` | test | Runtime zod parse/reject tests + map completeness |

## Notes

- Depends only on `@cortex-agent/server` (`workspace:*`) for the type-only DTO re-export, the
  runtime schema re-export, AND the AppRouter type re-export (all deep-imported from its built
  dist); this gives pnpm the topological order server → ui-contract. server does not import this
  package (acyclic).
- `dto.ts` / `schemas.ts` / `app-router.ts` all deep-import `@cortex-agent/server/dist/...`, so
  server must be built before this package typechecks. `pnpm -w build` (gate) handles the ordering;
  run it before `pnpm -w typecheck`.
- zod pinned to `^4.4.3` to match the version resolved in the workspace lock (agent-server
  now also depends on zod, as the schema source-of-truth lives there).
