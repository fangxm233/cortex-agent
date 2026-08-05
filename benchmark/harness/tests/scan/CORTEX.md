Update this file whenever this directory changes

Scanner tests reject leaks and inventory gaps and prove an isolated dynamic bundle run.

| filename | role | function |
|---|---|---|
| test_scanner.py | test | Proves leaks and closed-inventory failures |
| test_scan_cli.py | test | Verifies scanner CLI exits and redaction |
| test_real_agent_run.py | integration | Proves blocking thread merge and fail-closed mutations |
| test_trial_proxy_scan.py | test | Proves the four proxy sources scan clean and closed |
| docker-compose-never-pull.yaml | config | Forbids image pulls during the real trial |
| fake_claude.sh | fixture | Launches the deterministic offline model fixture |
| fake_claude.mjs | fixture | Calls the real thread MCP and emits role usage |
| stub_trial.py | helper | Builds the marked component-fixture container trial |
