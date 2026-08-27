Please update me when files in this folder change

Shared daemon-domain ownership for desktop and mobile.
The resource owns transport lifecycle and exact cache refreshes; facts stay locale-, interaction-, JSX-, and CSS-free.

| filename | role | function |
|---|---|---|
| useDaemonResource.ts | resource | Polls status every 5s, runs restart mutations, and invalidates exact daemon status plus every affected thread list |
| useDaemonResource.test.tsx | test | Tests polling gates, canonical facts, restart states, errors, and exact invalidation scopes |
| daemon-vm.ts | facts | Maps legal daemon states, nullable metrics, extras, and restart records to canonical headless facts |
| daemon-vm.test.ts | test | Tests all legal states, cancelled unknown tone, real metrics, extras, restart records, and empty fallback |
