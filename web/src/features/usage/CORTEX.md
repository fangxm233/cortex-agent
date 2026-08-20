Please update me when files in this folder change

Shared provider usage feature with a reusable view model and query hook.
Desktop owns the Settings panel while mobile can reuse per-row quota policy state without sharing layout.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Exports the usage API plus per-row policy target/view types |
| usage-vm.ts | vm | Builds quota, spend, freshness, timing, row policy, and legacy fallback views |
| usage-vm.test.ts | test | Tests row policy resolution, fallback inheritance, windows, severity, and timing |
| usage-policy-controls.ts | util | Shares threshold draft sync and per-row button disabled state |
| useUsage.ts | hook | Queries usage/config, updates window/root policy cache, tracks saves and refreshes |
| UsagePanel.tsx | view | Renders usage cards, inline quota-row controls, and the legacy fallback clear notice |
| UsagePanel.test.tsx | test | Tests row-target wiring, fallback reset/cache behavior, and refresh states |
