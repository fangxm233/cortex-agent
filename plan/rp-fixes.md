# Retire-profiles review fixes

Only use `/home/fangxin/Cortex-wt-rp-fixes`, branch `cortex/rp-fixes`, based on `e595d297a`. No changes to the other worktree, installed runtime, or live home; no install/restart. All runtime tests use scratch CORTEX_HOME under /tmp.

## Implementation
1. Make S10 materialization backend-compatible with recorded session identity. Resolve missing/incompatible choices using same-backend global default, otherwise first same-backend favorite; leave unmatched sessions unmaterialized rather than assign a different backend. Keep bound channels compatible too. Add regressions, including no matching favorite.
2. Do not mark S10 complete when immutable configuration prevents migration of existing legacy profiles. Minimal retry bookkeeping, no additional startup refusal. Test immutable then mutable migration.
3. Preserve explicit PI profile gateway modes (including provider anthropic / mode api); derive only when absent. Verify migration plus selection writer accepts declared provider-specific routes.
4. Update session.backend alongside selection on allowed history-free switches. Confirm/add run-time protection against resuming a recorded backend id through a different backend when selection was inherited from channel/default. Tests cover stale/missing selection and durable history.
5. Pass seedDefault:false for scheduled session creation and prove the Web next-conversation seed remains unchanged.
6. Share one in-process models-file read/modify/write lock between UI mutations and post-login gateway synchronization. No external-editor conflict detection or retry. Add controlled concurrency regression.

Delegate isolated source ownership to one-shot agents; use separate English commits for each fix, then inspect the integrated diff.

## Verification and handoff
- Run focused regressions as changes land, server typecheck, full server test script, and web test suite.
- Copy fresh live configuration/state/registry inputs read-only to a scratch home. Run S10 there only. Check original migration counts and explain live-data deltas; explicitly inspect qwen-ksu session/channel backend compatibility, archive fidelity, append-only registry, and idempotence.
- Report commits, fix summaries, suite outcomes (including skips), and rehearsal deltas. Commit implementation and a status/handoff update; leave main and the other worktree untouched.

## Completion — 2026-10-14 23:06 America/Denver

All six requested fixes implemented. Source verification anchor: `386beac4d`.

| Fix | Commit(s) | Result |
| --- | --- | --- |
| 1 | `6e6991f52` | S10 uses recorded backend for session/conversation and bound-channel choices. Missing compatible options remain unmaterialized. Request construction refuses cross-backend resume IDs, including selection inherited from channel/default and legacy session IDs. |
| 2 | `6ce5efe28` | Immutable S10 returns deferred; its version stays pending for a mutable boot, without a new startup refusal. |
| 3 | `9046ba0e2` | Explicit PI mode survives migration; the UI default validator accepts gateway-declared modes different from provider. Channel selection already supports this and is regression-tested. |
| 4 | `9508ffb6b`, `386beac4d` | History-free switches atomically patch recorded backend and selection through the public registry API. Existing durable backend identity remains authoritative. |
| 5 | `ec6f865d5` | Scheduled session creation passes `seedDefault:false`; the Web next-conversation model/agent seed remains unchanged. |
| 6 | `4bee04e16` | UI add/remove/default and login gateway sync share one in-process models transaction lock, including cache invalidation. No external-edit retry machinery. |

### Verification

From this worktree, with `CORTEX_HOME=/tmp/rp-fixes-tests-home`:
- `pnpm --filter @cortex-agent/server typecheck`: passed.
- `pnpm --filter @cortex-agent/server test`: **5,190 passed**, 1 existing artifact-gated managed-install test skipped. Isolated 4,835; shared 345; integration 10. Dependency-cruiser and shortcode lint passed.
- `pnpm --filter @cortex-agent/web test`: **2,390 passed**, 291 files.
- Focused regression tests demonstrated failures before the relevant fixes. Typecheck caught private-method usage in the initial backend-writer change; `386beac4d` fixes it through the public registry API, and the full suites above ran afterward.
- Logs: `/tmp/rp-fixes-typecheck.log`, `/tmp/rp-fixes-server-full.log`, `/tmp/rp-fixes-web-test.log`.

### Fresh copy-only S10 rehearsal

Scratch home: `/tmp/rp-fixes-s10-nvm_zj_6`. Only migration input files were copied read-only from the live home; S10 ran only against the copy.

| Check | Result | Delta from previous rehearsal |
| --- | --- | --- |
| Profiles → favorites | 8 → 7 | unchanged |
| Default | Claude / claude-opus-5-5[1m] / xhigh / plan | unchanged |
| Channels | 899, individually checked | +4 |
| Overrides | 23, individually checked | +4 |
| Registry sessions loaded | 1,596 | +4 |
| Named selections checked | 1,221 | +4 |
| Journal events appended | 1,222 | +4 |
| Schedules converted | 2 of 4 | unchanged |
| Deepseek flash thinking | xhigh | unchanged |
| Environments cleaned | 2 | unchanged |

Both unknown `qwen-ksu` sessions are recorded as PI. Their session **and channel** selections now use the first PI favorite: `openai-codex / gpt-5.6-sol / high / openai-codex`, rather than the global Claude default. Both resume IDs are unchanged. Zero materialized session/backend mismatches remain. Archive bytes, append-only registry, allowed changed-file set, registry reload, and byte-identical second invocation all passed.

Evidence: `/tmp/rp-fixes-rehearsal-metrics.json`, `/tmp/rp-fixes-rehearsal.log`; script `/tmp/rp-fixes-rehearsal.mts`.

No DTO shape changes, real-provider inference, web production build, install, hosting-server restart, live-home writes, main merge, or push. The original retire-profiles worktree was not modified. Subagents performed no git operations; commits were made serially by the parent.
