Please update me when files in this folder change

UI service domain — transport-neutral query, mutate, and subscribe facade over the domain modules.
Serves the TUI dashboard directly and the Web UI through the tRPC router bound here.

| filename | role | function |
|---|---|---|
| types.ts | types | UI DTOs, auth actions, and operation maps |
| input-schemas.ts | schemas | Validates UI inputs and plugin identities |
| plugins-shared.ts | util | Normalizes plugin catalog entries and pluginDirs |
| ui-service.ts | facade | routes UI operations through registered handlers |
| subscribe.ts | subscribe | turns event bus traffic into a UI event stream |
| trpc.ts | tRPC | shared tRPC router and procedure builders |
| app-router.ts | tRPC | tRPC router mirroring the UI operations |
| index.ts | entry | re-exports createUiService and public types |
| query/ | subdir | read-side UI operation handlers |
| mutate/ | subdir | write-side UI operation handlers |
