Update this file whenever this directory changes

Proxy tests prove host credential isolation, policy enforcement, and Docker egress containment.

| filename | role | function |
|---|---|---|
| synthetic.py | fixture | Runs the synthetic upstream and binds the adapter |
| docker_tools.py | fixture | Creates isolated trial networks and containers |
| test_proxy.py | test | Verifies forwarding, the declared request count, deadlines, and logs |
| test_container_boundary.py | test | Proves source and egress containment in Docker |
| test_proxy_manifest.py | test | Verifies the credential-free proxy manifest block |
| test_cli.py | test | Verifies structured startup, refusals and credential secrecy |
| test_adapter_selection.py | test | Verifies exact-key selection, the frozen cap binding, and refusals |
| test_anthropic_adapter.py | test | Verifies Anthropic API-key and subscription duties |
| test_deepseek_adapter.py | test | Verifies DeepSeek chat completions and sanitized terminal-SSE diagnostics under a frozen per-trial cap |
| test_adapter_seam.py | test | Verifies duty order, refusals, and audit |
| test_offline_containment.py | test | Proves H7 and host-set properties offline |
| test_openai_codex_adapter.py | test | Verifies the Codex responses adapter duties |
| test_openai_codex_second_host.py | test | Proves refresh shape and CP1, CP2, CP3 |
| test_lease_echo.py | test | Proves skew-invariant lease arming and revocation per adapter |
| test_row_four_trial_scan.py | test | Proves the codex row's flows scan clean and closed |
| test_export.py | test | Verifies the accounting export and its seam bytes |
| golden/ | fixture | Holds the export bytes the other side of the seam parses |
