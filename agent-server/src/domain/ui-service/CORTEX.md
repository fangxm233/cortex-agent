Please update me when files in this folder change

UI service domain — transport-neutral query, mutate, and subscribe facade over the domain modules.
Serves the TUI dashboard directly and the Web UI through the tRPC router bound here.

| filename | role | function |
|---|---|---|
| types.ts | type | Defines UI DTOs and platform configuration contract |
| query-input-schemas.ts | schemas | Validates extracted session/query read inputs including compact transcript detail routes |
| input-schemas.ts | schema | Validates UI operations and platform patches |
| plugins-shared.ts | utility | Normalizes plugin catalogs and effective scopes |
| ui-service.ts | core | Dispatches UI operations with safe mutation audit |
| subscribe.ts | subscribe | turns event bus traffic into a UI event stream |
| trpc.ts | core | Builds tRPC procedures and redacts secret errors |
| app-router.ts | entry | Routes typed UI queries and platform writes |
| index.ts | entry | re-exports createUiService and public types |
| query/ | subdir | read-side UI operation handlers |
| mutate/ | subdir | write-side UI operation handlers |
| platform-settings.ts | store | Persists and redacts platform connection settings |
