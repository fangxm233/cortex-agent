Please update me when files in this folder change

Shared provider usage feature with a reusable view model and query hook.
Desktop owns the Settings panel while mobile can reuse data without sharing layout.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Exports the public usage feature API |
| usage-vm.ts | vm | Builds known-bucket quota, spend, freshness, severity and reset views |
| usage-vm.test.ts | test | Tests provider states, window filtering, severity, notes and timing |
| useUsage.ts | hook | Queries status, ticks timing and refreshes immediately |
| UsagePanel.tsx | view | Renders usage cards with meters, live badge, spend tiles and refresh toolbar |
| UsagePanel.test.tsx | test | Tests querying, refresh spin, severity and error-only notes |
