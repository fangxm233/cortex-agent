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
