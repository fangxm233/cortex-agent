Update this file whenever this directory changes

Host launcher modules materialize production arms and record bounded trials.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes launcher APIs |
| arms.py | core | Builds arm-versioned vendor and Cortex agent configs |
| capability_ceilings.py | policy | Reads host envelope ceilings |
| capability_evidence.py | boundary | Validates capability evidence and committed proof sources |
| comparison_report.py | report | Reports every terminal outcome with canonical rewards |
| credential_capabilities.py | registry | Projects credential capabilities |
| deepseek_paid_smoke.py | boundary | Runs the bounded paid smoke contract |
| deepseek_paid_smoke_launcher.py | CLI | Preflights and records one pinned-image smoke |
| host_credential_vault.py | boundary | Transfers opaque host credentials |
| lease_bound.py | policy | Computes credential lease bounds |
| live_handshake.py | boundary | Captures one bounded native-default handshake and safe diagnostics |
| network_policy.py | boundary | Resolves a campaign's declared trial network |
| production_arms.py | registry | Resolves committed production bundles |
| production_home.py | boundary | Materializes sealed production homes |
| production_session.py | lifecycle | Runs production server arm sessions |
| trial_admission.py | boundary | Seals trial launch inputs |
| trial_admission_io.py | io | Writes admission records atomically |
| trial_proxy.py | core | Arms and revokes trial proxy routes |
| trial_seed.py | boundary | Parses immutable trial seed facts |
