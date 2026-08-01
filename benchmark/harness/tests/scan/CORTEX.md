Update this file whenever this directory changes

Scanner tests prove each required artifact source rejects credentials and host identities.

| filename | role | function |
|---|---|---|
| test_scanner.py | test | Proves leaks are found in all five sources |
| test_scan_cli.py | test | Verifies scanner CLI exits and redaction |
| docker-compose-never-pull.yaml | config | Forbids image pulls during the stub trial |
| stub_agent.sh | fixture | Emits clean C2/C3 trial artifacts in Docker |
| stub_trial.py | integration | Runs the installed harness and proxy end to end |
