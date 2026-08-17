Please update me when files in this folder change

Shared provider usage feature with a reusable view model and query hook.
Desktop owns the Settings panel while mobile can reuse data without sharing layout.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Exports the public usage feature API |
| usage-vm.ts | vm | Builds quota, spend, freshness and timing views |
| usage-vm.test.ts | test | Tests provider states, windows, spend and timing |
| useUsage.ts | hook | Queries status and invokes unthrottled refresh |
| UsagePanel.tsx | view | Renders desktop usage cards in Settings |
| UsagePanel.test.tsx | test | Tests querying, refresh feedback and provider groups |
