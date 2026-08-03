Update this file whenever this directory changes

Scanner tests reject leaks and prove a dynamic bundle run in an isolated container.

| filename | role | function |
|---|---|---|
| test_scanner.py | test | Proves leaks are found in all five sources |
| test_scan_cli.py | test | Verifies scanner CLI exits and redaction |
| test_real_agent_run.py | integration | Proves blocking thread merge and fail-closed mutations |
| docker-compose-never-pull.yaml | config | Forbids image pulls during the real trial |
| fake_claude.sh | fixture | Launches the deterministic offline model fixture |
| fake_claude.mjs | fixture | Calls the real thread MCP and emits role usage |
| stub_trial.py | helper | Audits the production adapter container trial |
