Please update me when files in this folder change

Cost domain — persists attempt-attributed accounting and pauses work during provider limits or outages.

| filename | role | function |
|---|---|---|
| cost-tracker.ts | core | Records attributed requests, tokens, spend and budgets |
| gateway-manager.ts | core | Manages the local usage gateway process |
| rate-limit-throttle.ts | core | Applies exact provider/window policy and publishes throttle windows |
| resume-registry.ts | core | Tracks provider-attributed interrupted work |
| usage-service.ts | service | Composes one usage row per observed (provider, billing kind) |
| usage-store.ts | core | Atomically persists newest provider observations |

## Usage rows are observed, not configured

`usage-service` never invents a row. A provider appears only because the gateway reported
spend for it or because a quota reading arrived; a provider that stops being used disappears
on the next cycle. There is no table of supported providers — an unknown id flows straight
through, with `KNOWN_DISPLAY_NAMES` supplying brand casing and a title-cased id as fallback.

Rows are keyed by `(provider, billing)`, so one provider can hold two rows at once:

- **subscription** — traffic on a plan listed in the `subscriptionBillingModes` setting. The
  gateway still prices these requests, but that figure is an imputed API-equivalent rate and
  not a bill, so the row shows quota windows and suppresses spend entirely.
- **api** — metered traffic. Carries spend and no quota windows.

Collection is **compose-then-commit**: one pass builds the whole table, then `usageStore.commit`
writes it. Two consequences worth knowing before changing it:

- Committing drops rows it omits, which is how stale providers disappear. When the gateway
  read fails, `guardDeletions` degrades to add-only so an outage cannot wipe history.
- `commit` keeps a stored quota observation that is newer than the composed one, because the
  table is built from a snapshot read before the write and a live `reportCodexQuota` push may
  land mid-cycle. Anything writing quota must use the same `(provider, billing)` key.

Spend comes from `/usage` grouped by `provider,billing_mode`, which the gateway supports from
aistatus 0.0.9. Against an older gateway that rejects composite grouping, collection falls back
once — then sticks for the process — to aggregating `format=records` client-side. Both routes
are held to the same window definitions (`today` is local midnight, `month` a rolling 30 days)
so the reported figures do not shift when the route changes.
