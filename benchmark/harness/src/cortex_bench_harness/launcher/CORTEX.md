Update this file whenever this directory changes

Host launcher modules materialize production arms and record bounded trials.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes launcher APIs |
| arms.py | core | Builds vendor and Cortex agent configs |
| capability_ceilings.py | policy | Reads host envelope ceilings |
| capability_evidence.py | boundary | Validates capability provenance |
| comparison_report.py | report | Builds campaign comparison reports |
| credential_capabilities.py | registry | Projects credential capabilities |
| deepseek_paid_smoke.py | boundary | Runs the bounded paid smoke contract |
| host_credential_vault.py | boundary | Transfers opaque host credentials |
| lease_bound.py | policy | Computes credential lease bounds |
| production_arms.py | registry | Resolves committed production bundles |
| production_home.py | boundary | Materializes sealed production homes |
| production_session.py | lifecycle | Runs production server arm sessions |
| trial_admission.py | boundary | Seals trial launch inputs |
| trial_admission_io.py | io | Writes admission records atomically |
| trial_proxy.py | core | Arms and revokes trial proxy routes |
| trial_seed.py | boundary | Parses immutable trial seed facts |
