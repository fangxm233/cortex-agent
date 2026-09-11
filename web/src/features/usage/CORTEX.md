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

## Rows are discovered, never enumerated

The provider list comes entirely from the server, which only reports providers it actually
observed. Nothing here may gate a row on a known-provider list, and `displayName` arrives
ready to render — do not localize it, because `!usage <provider>` matches on it.

A provider can appear twice, once per billing kind (`subscription` shows quota and no cost,
`api` shows cost and no quota). Use `view.key` (`provider::billing`) for React keys and DOM
lookups; `provider` alone is not unique. `PROVIDER_ORDER` pins only the two quota-bearing
providers to the top; everything else is ranked by `providerCompare` — quota first, then
subscription, then monthly spend — so a new provider slots in sensibly with no code change.
