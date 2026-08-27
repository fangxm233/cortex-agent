Update this file whenever this directory changes

Tests for the Python benchmark harness distribution.

| filename | role | function |
|---|---|---|
| capability_admission.py | fixture | Admits or refuses capability rows for one test without writing the registry |
| docker_gate.py | fixture | Skips container modules unless explicitly opted in |
| fixtures/ | fixture | Stores committed redacted vendor wire observations |
| full_suite/ | tests | Verifies isolated external full-suite execution |
| offline_package.py | fixture | Test-side alias for the production package builder in cortex_bench_harness.artifact_build |
| vendor_wire_capture.py | fixture | Captures isolated real Claude wire behavior |
| launcher/ | tests | Verifies arm routing and credential projections |
| package/ | tests | Verifies package-level contracts |
| proxy/ | tests | Proves credential and network containment |
| scan/ | tests | Proves leak detection and real offline agent runs |

## Tests that are red for a reason that predates this suite's use
Fifteen tests fail on a clean checkout as of 2026-08-27. None is a coverage gap on the paid launch
path, and none was caused by the mounted-runtime work; each is a test whose *trigger* stopped
triggering when the production code around it moved. They are listed so a future run can tell this
noise from a real regression.

`proxy/test_row_four_trial_scan.py` (8) arms a Codex adapter from a spec with no
`access_expires_at_ms`. `85cd9ec92` (2026-08-18, Codex campaign token preflight) made that expiry
mandatory, so the fixture is refused before the row it means to scan is ever built. The fixture was
last touched the day before, on 2026-08-17.

`launcher/test_trial_proxy_wiring.py` (3) reaches route revocation by making the bundle-root probe
return nothing. `35fd6459a` (2026-08-22, bundle root discovery) stopped deriving the root from that
command's output, so an empty answer is no longer an error and the install these tests expect to
fail now succeeds. Revocation itself is still proven --
`test_a_cancelled_setup_still_revokes_the_route` exercises the same path through Harbor's setup
timeout and passes.

`package/test_vendor_model_freeze.py` (4) needs the pinned Claude CLI. The Claude runtime on this
host does not match its pin and has no mount target, which is also why `--stage-runtimes` stages
only `pi` and `codex`.

`launcher/test_paid_campaign_launch.py` (6) is not a code failure at all: it preflights the
committed paid config, which verifies both pinned artifacts against the checkout. The npm scope
covers `agent-server/`, and an npm bundle build leaves ~14k untracked files under
`agent-server/bundled-dependencies/` which nothing gitignores. The provenance fingerprint reads
untracked files, so while that directory exists the tgz cannot match its record and preflight
refuses before printing anything — the tests then fail decoding empty stdout. Rebuild the npm
artifact with the directory in whatever state it will be in at launch, or expect these six.

## Proof pins that have to be refreshed when their proof moves
`capability_evidence.py` pins the sha256 of the test files that prove each capability's offline
contract, and `test_capability_evidence.py` separately pins the sha256 of the committed evidence
JSON. `7e8484d39` changed `tests/launcher/test_vendor_agents.py` — the file behind
`runtime_projection_test_sha256` — without refreshing either, so the pin was stale for a day.
Refreshing means: recompute the proof file's digest into `PI_CODEX_OFFLINE_CONTRACT` and the
evidence JSON, then recompute the evidence JSON's own digest into the test. Both, in that order.
