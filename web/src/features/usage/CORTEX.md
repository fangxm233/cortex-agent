Please update me when files in this folder change

Shared provider usage feature with a reusable view model and query hook.
Desktop owns the Settings panel while mobile can reuse per-row quota policy state without sharing layout.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Exports the usage API plus per-row policy target/view types |
| usage-vm.ts | vm | Builds quota, canonical USD spend, freshness, timing, policy and fallback views |
| usage-vm.test.ts | test | Tests policy inheritance, window selection, severity and timing |
| usage-policy-controls.ts | util | Shares threshold draft sync and per-row button disabled state |
| useUsage.ts | hook | Queries usage/config, updates window/root policy cache, tracks saves and refreshes |
| UsagePanel.tsx | view | Renders cards, animated quota and policy actions |
| UsagePanel.test.tsx | test | Tests quota motion, layout, policies and refresh |
