Update this file whenever this directory changes

Launcher tests cover production arm routing, admission and evidence recording.

| filename | role | function |
|---|---|---|
| trial_fixtures.py | fixture | Builds production trial documents |
| paid_campaign_fixtures.py | fixture | Stages synthetic checkouts and valid provenance |
| trial_proxy_fixtures.py | fixture | Builds offline trial seeds and recording handles |
| test_arms.py | test | Verifies arm/task selection, seed binding and direct-arm routing |
| test_campaign.py | test | Verifies campaign execution and score admission semantics |
| test_capability_ceilings.py | test | Verifies committed paid-envelope ceilings |
| test_capability_evidence.py | test | Verifies live evidence and offline proof digests |
| test_capability_state_gate.py | test | Verifies offline and live capability admission |
| test_comparison_report.py | test | Verifies comparison rewards and outcome semantics |
| test_container_stop_observation.py | test | Verifies post-stop observations |
| test_credential_capabilities.py | test | Verifies current capability projections and evidence bindings |
| test_deepseek_paid_smoke.py | test | Verifies paid smoke inputs |
| test_deepseek_paid_smoke_launcher.py | test | Verifies pinned-image smoke launching and evidence |
| test_external_task_source.py | test | Verifies external corpus expansion, selection, staging and trial-id composition |
| test_campaign_progress.py | test | Verifies the run-level progress ledger and its best-effort writes |
| test_codex_refresh_binding.py | test | Verifies OAuth refresh material binds to the adapter and never travels |
| test_host_credential_vault.py | test | Verifies opaque credential transfer |
| test_host_finalization.py | test | Verifies envelopes, leak gates and scan diagnostics |
| test_live_handshake_permit.py | test | Verifies native-default bootstrap bounds and safe diagnostics |
| test_leak_scan_finalization_docker.py | test | Proves clean publication after verifier alias cleanup |
| test_paid_campaign_launch.py | test | Verifies hermetic launch, auth and provenance gates |
| test_production_arms.py | test | Verifies committed arm bundles |
| test_result_summary.py | test | Verifies explicit thinking projection in public result summaries |
| test_runtime_mounts.py | test | Verifies staged runtime mounts reach containers read-only or are refused |
| test_production_home.py | test | Verifies sealed production homes |
| test_production_session.py | test | Verifies sessions and all-arm terminal outcomes |
| test_production_session_admission.py | test | Verifies sealed session execution |
| test_production_pi_child_docker.py | test | Proves real PI child caps across catalog refresh |
| test_trial_admission.py | test | Verifies Harbor trial admission |
| test_trial_proxy_wiring.py | test | Verifies bootstrap failures and route revocation |
| test_verifier_gate.py | test | Verifies the pre-agent gate separates a verifier that could not start from an agent that was wrong |
| test_vendor_agents.py | test | Verifies vendor setup, usage, caps and containment |
| test_vendor_baseline_isolation.py | test | Verifies vendor baseline isolation |
| test_vendor_codex_lifecycle_docker.py | test | Proves current Codex lifecycle in real Docker |
| test_vendor_lifecycle_docker.py | test | Proves PI lifecycle and timeout containment in real Docker |
| test_vendor_pi_codex_lifecycle_docker.py | test | Proves the admitted PI OpenAI Codex path in real Docker |
| test_vendor_pi_completion_cap_docker.py | test | Proves admitted PI caps traverse the proxy in Docker |
