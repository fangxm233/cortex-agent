Update this file whenever this directory changes

Launcher tests cover production arm routing, admission and evidence recording.

| filename | role | function |
|---|---|---|
| trial_fixtures.py | fixture | Builds production trial documents |
| test_arms.py | test | Verifies arm routing and vendor version isolation |
| test_campaign.py | test | Verifies campaign execution, outcomes and delivery artifacts |
| test_capability_ceilings.py | test | Verifies host envelope ceilings |
| test_capability_evidence.py | test | Verifies per-capability provenance metadata |
| test_capability_state_gate.py | test | Verifies credential capability admission |
| test_comparison_report.py | test | Verifies comparison rewards and outcome semantics |
| test_container_stop_observation.py | test | Verifies post-stop observations |
| test_credential_capabilities.py | test | Verifies capability projections and evidence bindings |
| test_deepseek_paid_smoke.py | test | Verifies paid smoke inputs |
| test_host_credential_vault.py | test | Verifies opaque credential transfer |
| test_host_finalization.py | test | Verifies Cortex/vendor envelopes and mapped-root scans |
| test_live_handshake_permit.py | test | Verifies one-use live bootstrap authorization |
| test_paid_campaign_launch.py | test | Verifies paid campaign preflight |
| test_production_arms.py | test | Verifies committed arm bundles |
| test_production_home.py | test | Verifies sealed production homes |
| test_production_session.py | test | Verifies production server sessions |
| test_production_session_admission.py | test | Verifies sealed session execution |
| test_trial_admission.py | test | Verifies Harbor trial admission |
| test_trial_proxy_wiring.py | test | Verifies proxy lifecycle wiring |
| test_vendor_agents.py | test | Verifies pinned vendor setup and dummy runtime files |
| test_vendor_baseline_isolation.py | test | Verifies vendor baseline isolation |
| test_vendor_lifecycle_docker.py | test | Proves vendor lifecycle and failures in real Docker |
