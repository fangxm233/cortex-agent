Update this file whenever this directory changes

Scanner tests reject leaks and prove a real bundle run in an isolated container.

| filename | role | function |
|---|---|---|
| test_scanner.py | test | Proves leaks are found in all five sources |
| test_scan_cli.py | test | Verifies scanner CLI exits and redaction |
| test_real_agent_run.py | integration | Runs real agent-run with a fake model backend |
| docker-compose-never-pull.yaml | config | Forbids image pulls during the real trial |
| fake_claude.sh | fixture | Emits pinned cache-bearing stream JSON offline |
| stub_trial.py | helper | Builds and audits the genuine container trial |
