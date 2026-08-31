Update this file whenever this directory changes

Host launcher modules materialize production arms and record bounded trials.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes launcher APIs |
| arms.py | core | Builds arm-versioned vendor and Cortex agent configs |
| capability_ceilings.py | policy | Reads host envelope ceilings |
| capability_evidence.py | boundary | Validates current capability evidence and committed proofs |
| comparison_report.py | report | Reports every terminal outcome with canonical rewards |
| credential_capabilities.py | registry | Projects capabilities bound to current evidence |
| deepseek_paid_smoke.py | boundary | Runs the bounded paid smoke contract |
| deepseek_paid_smoke_launcher.py | CLI | Preflights and records one pinned-image smoke |
| host_credential_vault.py | boundary | Transfers opaque host credentials |
| lease_bound.py | policy | Computes credential lease bounds |
| live_handshake.py | boundary | Captures one bounded native-default handshake and safe diagnostics |
| network_policy.py | boundary | Resolves a campaign's declared trial network |
| production_arms.py | registry | Resolves bundles and pinned profile metadata |
| production_home.py | boundary | Materializes sealed production homes |
| production_session.py | lifecycle | Runs server sessions, proves the attempt workdir contract, records non-success terminals |
| runtime_mounts.py | policy | Maps staged runtime names to their fixed read-only container targets |
| trial_admission.py | boundary | Seals trial launch inputs, admits what a pinned image declares for itself, proves the container kept its CPU pin, and discards trial scratch |
| trial_admission_io.py | io | Writes admission records atomically and pins each trial to its concurrency slot's CPUs |
| trial_proxy.py | core | Arms and revokes trial proxy routes |
| trial_seed.py | boundary | Parses immutable trial seed facts |
