Please update me when files in this folder change

Shared provider usage feature with a reusable view model and query hook.
Desktop owns the Settings panel while mobile can reuse data without sharing layout.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Exports the usage API and policy-control types |
| usage-vm.ts | vm | Builds quota, spend, freshness, timing and ready/unknown policy views |
| usage-vm.test.ts | test | Tests provider policy, unknown config, windows, severity and timing |
| usage-policy-controls.ts | util | Shares threshold draft sync and policy button disabled state |
| useUsage.ts | hook | Queries usage/config, hides unknown policies, tracks saves and refreshes |
| UsagePanel.tsx | view | Renders usage cards, spend tiles and ready-state policy controls |
| UsagePanel.test.tsx | test | Tests config wiring, hidden unknown policies, saves and refresh states |
